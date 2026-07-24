// SPDX-License-Identifier: GPL-2.0
// proxy/listener.go — Multi-port TCP and UDP listeners.
// Each listener accepts connections on a configured port and routes them
// through the detection pipeline before forwarding to the backend.

package proxy

import (
	"context"
	"fmt"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"ngfw-monitor/detect"
)

// ──────────────────────────────────────────────────────────────────────────────
// TCP Listener
// ──────────────────────────────────────────────────────────────────────────────

// TCPListener handles incoming TCP connections on a single port.
type TCPListener struct {
	config   ListenerConfig
	engine   *ProxyEngine
	listener net.Listener
	connWg   sync.WaitGroup
	active   atomic.Int64
}

// NewTCPListener creates and binds a TCP listener.
func NewTCPListener(cfg ListenerConfig, engine *ProxyEngine) (*TCPListener, error) {
	addr := fmt.Sprintf(":%d", cfg.ListenPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("bind tcp %s: %w", addr, err)
	}

	return &TCPListener{
		config:   cfg,
		engine:   engine,
		listener: ln,
	}, nil
}

// Serve accepts connections until the context is cancelled.
func (tl *TCPListener) Serve(ctx context.Context) {
	for {
		conn, err := tl.listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return // Shutdown requested
			default:
				log.Printf("[tcp:%d] Accept error: %v", tl.config.ListenPort, err)
				continue
			}
		}

		tl.active.Add(1)
		tl.engine.stats.IncrementActive()
		tl.connWg.Add(1)

		go func(clientConn net.Conn) {
			defer func() {
				tl.connWg.Done()
				tl.active.Add(-1)
				tl.engine.stats.DecrementActive()
			}()
			tl.handleConnection(ctx, clientConn)
		}(conn)
	}
}

// handleConnection processes a single TCP connection through the full pipeline:
// 1. Create connection context
// 2. Read initial bytes for protocol detection
// 3. Connect to backend
// 4. Run bidirectional forwarding with analysis tee
// 5. Log connection record on close
func (tl *TCPListener) handleConnection(ctx context.Context, clientConn net.Conn) {
	defer clientConn.Close()

	// Extract client address
	clientAddr := clientConn.RemoteAddr().(*net.TCPAddr)

	// Create connection context
	connCtx := &ConnContext{
		ConnID:          uuid.New().String(),
		ClientIP:        clientAddr.IP,
		ClientPort:      uint16(clientAddr.Port),
		ListenPort:      tl.config.ListenPort,
		BackendAddr:     tl.config.BackendAddr,
		ExpectedService: tl.config.Service,
		Transport:       tl.config.Transport,
		StartTime:       time.Now(),
		CloseReason:     "normal",
	}

	// Emit connection-start detection (INFO level for audit)
	tl.engine.bus.EmitDetection(detect.Detection{
		ID:         "CONN-START-001",
		Timestamp:  connCtx.StartTime,
		Severity:   detect.SevInfo,
		Category:   detect.CatConnLifecycle,
		Protocol:   connCtx.ExpectedService,
		SourceIP:   connCtx.ClientIP.String(),
		SourcePort: connCtx.ClientPort,
		DestPort:   connCtx.ListenPort,
		Summary:    fmt.Sprintf("New connection to :%d (%s)", connCtx.ListenPort, connCtx.ExpectedService),
		ConnID:     connCtx.ConnID,
	})

	// Read initial bytes for protocol detection (peek without consuming)
	initialBuf := make([]byte, 1024)
	clientConn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := clientConn.Read(initialBuf)
	clientConn.SetReadDeadline(time.Time{}) // Clear deadline

	if err != nil {
		connCtx.CloseReason = "read_error"
		tl.emitClose(connCtx)
		return
	}
	initialData := initialBuf[:n]

	// Protocol detection on initial bytes
	fp := tl.engine.protoDetector.Detect(initialData, connCtx.ListenPort, connCtx.ExpectedService)
	connCtx.DetectedProtocol = fp.Protocol
	connCtx.ProtoConfidence = fp.Confidence
	connCtx.ProtoMismatch = fp.Mismatch

	// Run analyzers on initial data (client → server direction)
	tl.engine.analyzers.AnalyzeStream(connCtx, initialData, true)

	// Connect to backend
	backendConn, err := net.DialTimeout("tcp", tl.config.BackendAddr, 5*time.Second)
	if err != nil {
		connCtx.CloseReason = "backend_unreachable"
		tl.engine.bus.EmitDetection(detect.Detection{
			ID:         "CONN-BACKEND-ERR",
			Timestamp:  time.Now(),
			Severity:   detect.SevLow,
			Category:   detect.CatConnLifecycle,
			Protocol:   connCtx.ExpectedService,
			SourceIP:   connCtx.ClientIP.String(),
			SourcePort: connCtx.ClientPort,
			DestPort:   connCtx.ListenPort,
			Summary:    fmt.Sprintf("Backend unreachable: %s", tl.config.BackendAddr),
			ConnID:     connCtx.ConnID,
		})
		tl.emitClose(connCtx)
		return
	}
	defer backendConn.Close()

	// Extract backend address info
	if backendTCP, ok := backendConn.RemoteAddr().(*net.TCPAddr); ok {
		connCtx.ServerIP = backendTCP.IP
		connCtx.ServerPort = uint16(backendTCP.Port)
	}

	// Forward the initial data that was read for detection
	_, err = backendConn.Write(initialData)
	if err != nil {
		connCtx.CloseReason = "backend_write_error"
		tl.emitClose(connCtx)
		return
	}
	connCtx.BytesFromClient = int64(len(initialData))

	// Bidirectional forwarding with analysis tee
	forwarder := NewForwarder(connCtx, tl.engine.analyzers,
		tl.engine.config.Detection.MaxPayloadInspect)
	forwarder.Forward(ctx, clientConn, backendConn)

	// Connection complete — emit close record
	tl.emitClose(connCtx)
}

// emitClose sends the connection record to the detection bus.
func (tl *TCPListener) emitClose(ctx *ConnContext) {
	record := ctx.ToConnectionRecord()
	tl.engine.bus.EmitConnectionClose(record)
}

// Close stops the listener.
func (tl *TCPListener) Close() {
	tl.listener.Close()
	tl.connWg.Wait()
}

// ActiveConnections returns the current number of active connections.
func (tl *TCPListener) ActiveConnections() int64 {
	return tl.active.Load()
}

// ──────────────────────────────────────────────────────────────────────────────
// UDP Listener
// ──────────────────────────────────────────────────────────────────────────────

// udpSession tracks a single client's UDP "session" (source addr → backend mapping).
type udpSession struct {
	clientAddr  *net.UDPAddr
	backendConn *net.UDPConn
	lastActive  time.Time
	mu          sync.Mutex
}

// UDPListener handles incoming UDP datagrams on a single port.
type UDPListener struct {
	config   ListenerConfig
	engine   *ProxyEngine
	conn     *net.UDPConn
	sessions sync.Map // key: clientAddr.String() → *udpSession
}

// NewUDPListener creates and binds a UDP listener.
func NewUDPListener(cfg ListenerConfig, engine *ProxyEngine) (*UDPListener, error) {
	addr, err := net.ResolveUDPAddr("udp", fmt.Sprintf(":%d", cfg.ListenPort))
	if err != nil {
		return nil, fmt.Errorf("resolve udp addr: %w", err)
	}

	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return nil, fmt.Errorf("bind udp %s: %w", addr, err)
	}

	return &UDPListener{
		config: cfg,
		engine: engine,
		conn:   conn,
	}, nil
}

// Serve reads datagrams and forwards them to the backend.
func (ul *UDPListener) Serve(ctx context.Context) {
	buf := make([]byte, 65536) // Max UDP datagram size

	// Session cleanup goroutine
	go ul.cleanupSessions(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		ul.conn.SetReadDeadline(time.Now().Add(1 * time.Second))
		n, clientAddr, err := ul.conn.ReadFromUDP(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue // Read timeout, check context
			}
			select {
			case <-ctx.Done():
				return
			default:
				log.Printf("[udp:%d] Read error: %v", ul.config.ListenPort, err)
				continue
			}
		}

		data := make([]byte, n)
		copy(data, buf[:n])

		// Create connection context for this datagram
		connCtx := &ConnContext{
			ConnID:          uuid.New().String(),
			ClientIP:        clientAddr.IP,
			ClientPort:      uint16(clientAddr.Port),
			ListenPort:      ul.config.ListenPort,
			BackendAddr:     ul.config.BackendAddr,
			ExpectedService: ul.config.Service,
			Transport:       "udp",
			StartTime:       time.Now(),
		}

		// Protocol detection
		fp := ul.engine.protoDetector.Detect(data, ul.config.ListenPort, ul.config.Service)
		connCtx.DetectedProtocol = fp.Protocol
		connCtx.ProtoConfidence = fp.Confidence
		connCtx.ProtoMismatch = fp.Mismatch

		// Run analyzers
		ul.engine.analyzers.AnalyzeStream(connCtx, data, true)

		// Forward to backend
		ul.forwardDatagram(ctx, clientAddr, data)
	}
}

// forwardDatagram sends a datagram to the backend and relays the response.
func (ul *UDPListener) forwardDatagram(ctx context.Context, clientAddr *net.UDPAddr, data []byte) {
	// Get or create session
	key := clientAddr.String()
	var sess *udpSession

	if existing, ok := ul.sessions.Load(key); ok {
		sess = existing.(*udpSession)
	} else {
		// Resolve backend address
		backendAddr, err := net.ResolveUDPAddr("udp", ul.config.BackendAddr)
		if err != nil {
			log.Printf("[udp:%d] Failed to resolve backend %s: %v",
				ul.config.ListenPort, ul.config.BackendAddr, err)
			return
		}

		backendConn, err := net.DialUDP("udp", nil, backendAddr)
		if err != nil {
			log.Printf("[udp:%d] Failed to connect to backend %s: %v",
				ul.config.ListenPort, ul.config.BackendAddr, err)
			return
		}

		sess = &udpSession{
			clientAddr:  clientAddr,
			backendConn: backendConn,
			lastActive:  time.Now(),
		}
		ul.sessions.Store(key, sess)

		// Start response relay goroutine
		go ul.relayResponses(ctx, sess, key)
	}

	sess.mu.Lock()
	sess.lastActive = time.Now()
	sess.mu.Unlock()

	// Send to backend
	_, err := sess.backendConn.Write(data)
	if err != nil {
		log.Printf("[udp:%d] Backend write error: %v", ul.config.ListenPort, err)
	}
}

// relayResponses reads responses from the backend and sends them back to the client.
func (ul *UDPListener) relayResponses(ctx context.Context, sess *udpSession, key string) {
	buf := make([]byte, 65536)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		sess.backendConn.SetReadDeadline(time.Now().Add(30 * time.Second))
		n, err := sess.backendConn.Read(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				// Check if session is still alive
				sess.mu.Lock()
				idle := time.Since(sess.lastActive)
				sess.mu.Unlock()
				if idle > 2*time.Minute {
					ul.sessions.Delete(key)
					sess.backendConn.Close()
					return
				}
				continue
			}
			ul.sessions.Delete(key)
			sess.backendConn.Close()
			return
		}

		responseData := buf[:n]

		// Analyze response
		connCtx := &ConnContext{
			ConnID:          uuid.New().String(),
			ClientIP:        sess.clientAddr.IP,
			ClientPort:      uint16(sess.clientAddr.Port),
			ListenPort:      ul.config.ListenPort,
			ExpectedService: ul.config.Service,
		}
		ul.engine.analyzers.AnalyzeStream(connCtx, responseData, false)

		// Send response back to client
		_, err = ul.conn.WriteToUDP(responseData, sess.clientAddr)
		if err != nil {
			log.Printf("[udp:%d] Client write error: %v", ul.config.ListenPort, err)
		}
	}
}

// cleanupSessions removes idle UDP sessions periodically.
func (ul *UDPListener) cleanupSessions(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			ul.sessions.Range(func(key, value any) bool {
				sess := value.(*udpSession)
				sess.mu.Lock()
				idle := time.Since(sess.lastActive)
				sess.mu.Unlock()
				if idle > 2*time.Minute {
					ul.sessions.Delete(key)
					sess.backendConn.Close()
				}
				return true
			})
		}
	}
}

// Close stops the UDP listener.
func (ul *UDPListener) Close() {
	ul.conn.Close()
	// Close all backend connections
	ul.sessions.Range(func(key, value any) bool {
		sess := value.(*udpSession)
		sess.backendConn.Close()
		ul.sessions.Delete(key)
		return true
	})
}
