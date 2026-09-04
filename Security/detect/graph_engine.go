// SPDX-License-Identifier: GPL-2.0
// detect/graph_engine.go — Cross-protocol session graph correlation engine.

package detect

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	GraphIncidentThreshold = 2 // Number of distinct protocols required for an incident
	GraphTimeWindow        = 15 * time.Minute // Time window to track cross-protocol attacks
)

type GraphNode struct {
	SourceIP     string
	Protocols    map[string]time.Time
	LastIncident time.Time
}

type GraphEngine struct {
	bus   *DetectionBus
	nodes map[string]*GraphNode
	mu    sync.Mutex
}

func NewGraphEngine(bus *DetectionBus) *GraphEngine {
	ge := &GraphEngine{
		bus:   bus,
		nodes: make(map[string]*GraphNode),
	}
	bus.Subscribe(ge)
	go ge.cleanupLoop()
	return ge
}

func (ge *GraphEngine) OnDetection(d Detection) {
	// Ignore benign information and the graph incidents themselves to avoid loops
	if d.Severity < SevMedium || strings.HasPrefix(d.ID, "GRAPH-") {
		return
	}

	ge.mu.Lock()
	defer ge.mu.Unlock()

	node, exists := ge.nodes[d.SourceIP]
	if !exists {
		node = &GraphNode{
			SourceIP:  d.SourceIP,
			Protocols: make(map[string]time.Time),
		}
		ge.nodes[d.SourceIP] = node
	}

	now := time.Now()
	node.Protocols[d.Protocol] = now

	// Check for cross-protocol attacks
	recentProtocols := 0
	var involvedProtocols []string

	for proto, timestamp := range node.Protocols {
		if now.Sub(timestamp) <= GraphTimeWindow {
			recentProtocols++
			involvedProtocols = append(involvedProtocols, proto)
		} else {
			// Clean up old entries
			delete(node.Protocols, proto)
		}
	}

	// Trigger incident if threshold met and we haven't alerted recently
	if recentProtocols >= GraphIncidentThreshold && now.Sub(node.LastIncident) > GraphTimeWindow {
		node.LastIncident = now
		
		// Emit out-of-band so we don't block the caller
		go func(srcIP string, protos []string, trig Detection) {
			ge.bus.EmitDetection(Detection{
				ID:         "GRAPH-INCIDENT-001",
				Timestamp:  time.Now(),
				Severity:   SevCritical,
				Category:   "multi-stage-attack",
				Protocol:   "Multiple",
				SourceIP:   srcIP,
				SourcePort: 0,
				DestPort:   0,
				Summary:    fmt.Sprintf("Cross-protocol attack chain detected from %s spanning protocols: %s", srcIP, strings.Join(protos, ", ")),
				ConnID:     trig.ConnID,
				Details: map[string]any{
					"involved_protocols": protos,
					"triggering_alert":   trig.ID,
					"time_window":        GraphTimeWindow.String(),
				},
			})
		}(d.SourceIP, involvedProtocols, d)
	}
}

func (ge *GraphEngine) OnConnectionClose(c ConnectionRecord) {
	// Not needed for the graph engine
}

func (ge *GraphEngine) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		<-ticker.C
		ge.mu.Lock()
		now := time.Now()
		for ip, node := range ge.nodes {
			if now.Sub(node.LastIncident) > GraphTimeWindow*2 {
				// Remove stale nodes to save memory
				delete(ge.nodes, ip)
			}
		}
		ge.mu.Unlock()
	}
}
