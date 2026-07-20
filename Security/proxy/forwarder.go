// SPDX-License-Identifier: GPL-2.0
// proxy/forwarder.go — Bidirectional data relay between client and backend.
// Uses tee readers to feed data through the detection pipeline while
// forwarding transparently. Tracks byte counts and connection health.

package proxy

import (
	"context"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// Forwarder — bidirectional relay with analysis tee
// ──────────────────────────────────────────────────────────────────────────────

// Forwarder handles bidirectional data transfer between client and backend
// while feeding data through protocol analyzers.
type Forwarder struct {
	connCtx     *ConnContext
	analyzers   *AnalyzerRouter
	maxInspect  int  // Max bytes to send to analyzers per direction
}

// NewForwarder creates a forwarder for a connection.
func NewForwarder(ctx *ConnContext, analyzers *AnalyzerRouter, maxInspect int) *Forwarder {
	if maxInspect <= 0 {
		maxInspect = 65536 // Default 64KB
	}
	return &Forwarder{
		connCtx:    ctx,
		analyzers:  analyzers,
		maxInspect: maxInspect,
	}
}

// Forward runs bidirectional relay between client and backend.
// It blocks until both directions are done (EOF, error, or context cancel).
func (f *Forwarder) Forward(ctx context.Context, clientConn, backendConn net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)

	// Client → Backend (fromClient = true)
	go func() {
		defer wg.Done()
		f.relay(ctx, clientConn, backendConn, true)
		// Signal the other direction to finish by closing the write side
		if tc, ok := backendConn.(*net.TCPConn); ok {
			tc.CloseWrite()
		}
	}()

	// Backend → Client (fromClient = false)
	go func() {
		defer wg.Done()
		f.relay(ctx, backendConn, clientConn, false)
		if tc, ok := clientConn.(*net.TCPConn); ok {
			tc.CloseWrite()
		}
	}()

	wg.Wait()
}

// relay copies data from src to dst while sending chunks to analyzers.
func (f *Forwarder) relay(ctx context.Context, src, dst net.Conn, fromClient bool) {
	buf := make([]byte, 32768) // 32KB read buffer
	var totalInspected int64
	var inspected atomic.Int64

	for {
		// Check for cancellation
		select {
		case <-ctx.Done():
			f.connCtx.CloseReason = "context_cancelled"
			return
		default:
		}

		// Set read deadline to prevent indefinite blocking
		src.SetReadDeadline(time.Now().Add(60 * time.Second))

		n, err := src.Read(buf)
		if n > 0 {
			data := buf[:n]

			// Update byte counters
			if fromClient {
				f.connCtx.BytesFromClient += int64(n)
			} else {
				f.connCtx.BytesToClient += int64(n)
			}

			// Feed to analyzers (only up to maxInspect bytes per direction)
			currentInspected := inspected.Load()
			if currentInspected < int64(f.maxInspect) {
				// Calculate how much we can still inspect
				remaining := int64(f.maxInspect) - currentInspected
				inspectLen := int64(n)
				if inspectLen > remaining {
					inspectLen = remaining
				}

				// Make a copy for the analyzer (don't block forwarding)
				analyzeData := make([]byte, inspectLen)
				copy(analyzeData, data[:inspectLen])

				f.analyzers.AnalyzeStream(f.connCtx, analyzeData, fromClient)
				inspected.Add(inspectLen)
				totalInspected += inspectLen
			}

			// Forward to destination
			written, writeErr := dst.Write(data)
			if writeErr != nil {
				f.connCtx.CloseReason = "write_error"
				return
			}
			if written != n {
				f.connCtx.CloseReason = "short_write"
				return
			}
		}

		if err != nil {
			if err == io.EOF {
				// Normal close
				return
			}
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				// Read timeout — check if we should keep going
				select {
				case <-ctx.Done():
					f.connCtx.CloseReason = "context_cancelled"
					return
				default:
					continue // Try reading again
				}
			}
			// Other errors (connection reset, etc.)
			if isConnectionReset(err) {
				f.connCtx.CloseReason = "reset"
			} else {
				f.connCtx.CloseReason = "error"
			}
			return
		}
	}
}

// isConnectionReset checks if the error is a connection reset.
func isConnectionReset(err error) bool {
	if opErr, ok := err.(*net.OpError); ok {
		return opErr.Err.Error() == "connection reset by peer"
	}
	return false
}

// ──────────────────────────────────────────────────────────────────────────────
// CountingWriter — wraps a writer to count bytes written
// ──────────────────────────────────────────────────────────────────────────────

// CountingWriter wraps an io.Writer and counts bytes written.
type CountingWriter struct {
	Writer io.Writer
	Count  atomic.Int64
}

// Write writes data and increments the counter.
func (cw *CountingWriter) Write(p []byte) (int, error) {
	n, err := cw.Writer.Write(p)
	cw.Count.Add(int64(n))
	return n, err
}
