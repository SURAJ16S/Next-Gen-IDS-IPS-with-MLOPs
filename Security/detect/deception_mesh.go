// SPDX-License-Identifier: GPL-2.0
// detect/deception_mesh.go — Deception Mesh for honeypot traps.

package detect

import (
	"fmt"
	"net"
	"sync"
	"time"
)

type DeceptionMesh struct {
	bus   *DetectionBus
	ports []int
	mu    sync.Mutex
}

// NewDeceptionMesh creates a new deception mesh listening on the specified honeypot ports.
// Recommended ports: 23 (Telnet), 3306 (MySQL), 5432 (PostgreSQL).
func NewDeceptionMesh(bus *DetectionBus, honeypotPorts []int) *DeceptionMesh {
	dm := &DeceptionMesh{
		bus:   bus,
		ports: honeypotPorts,
	}
	return dm
}

// Start launches the honeypot listeners.
func (dm *DeceptionMesh) Start() {
	for _, port := range dm.ports {
		go dm.listenOnPort(port)
	}
}

func (dm *DeceptionMesh) listenOnPort(port int) {
	addr := fmt.Sprintf("0.0.0.0:%d", port)
	l, err := net.Listen("tcp", addr)
	if err != nil {
		// Port might be in use, log and ignore for now.
		fmt.Printf("Deception Mesh: Could not bind to port %d (maybe in use): %v\n", port, err)
		return
	}
	defer l.Close()
	fmt.Printf("Deception Mesh: Active on port %d\n", port)

	for {
		conn, err := l.Accept()
		if err != nil {
			continue
		}
		
		// Immediately flag connection as malicious
		remoteAddr := conn.RemoteAddr().(*net.TCPAddr)
		
		// Emit block event
		dm.bus.EmitDetection(Detection{
			ID:         "MESH-TRIPWIRE-001",
			Timestamp:  time.Now(),
			Severity:   SevCritical,
			Category:   "deception-tripwire",
			Protocol:   "TCP",
			SourceIP:   remoteAddr.IP.String(),
			SourcePort: uint16(remoteAddr.Port),
			DestPort:   uint16(port),
			Summary:    fmt.Sprintf("Attacker touched deception mesh port %d", port),
			ConnID:     fmt.Sprintf("mesh-%s-%d", remoteAddr.IP.String(), time.Now().UnixNano()),
			Details: map[string]any{
				"honeypot_port": port,
				"action":        "immediate_block",
			},
		})

		// Briefly read to capture any initial payload, then drop
		go func(c net.Conn, p int) {
			defer c.Close()
			c.SetDeadline(time.Now().Add(2 * time.Second))
			buf := make([]byte, 1024)
			n, _ := c.Read(buf)
			if n > 0 {
				dm.bus.EmitDetection(Detection{
					ID:         "MESH-PAYLOAD-001",
					Timestamp:  time.Now(),
					Severity:   SevHigh,
					Category:   "deception-payload",
					Protocol:   "TCP",
					SourceIP:   remoteAddr.IP.String(),
					SourcePort: uint16(remoteAddr.Port),
					DestPort:   uint16(p),
					Summary:    fmt.Sprintf("Captured payload on deception port %d", p),
					ConnID:     fmt.Sprintf("mesh-%s-%d", remoteAddr.IP.String(), time.Now().UnixNano()),
					RawEvidence: truncate(string(buf[:n]), 200),
				})
			}
		}(conn, port)
	}
}
