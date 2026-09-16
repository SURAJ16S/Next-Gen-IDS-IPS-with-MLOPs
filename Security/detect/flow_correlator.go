// SPDX-License-Identifier: GPL-2.0
package detect

import (
	"fmt"
	"sync"
	"time"
)

// SSHFeatureVector is the fully merged set of L4 + L7 features,
// ready for JSON serialization to the Python ML microservice.
type SSHFeatureVector struct {
	// Identity
	FlowID string `json:"flow_id"`
	ConnID string `json:"conn_id"`
	SrcIP  string `json:"src_ip"`
	DstIP  string `json:"dst_ip"`
	SrcPort uint16 `json:"src_port"`
	DstPort uint16 `json:"dst_port"`

	// L4 Features (from FlowRecord)
	DurationMs     float64 `json:"flow_duration_ms"`
	FwdPkts        int64   `json:"fwd_pkts"`
	BwdPkts        int64   `json:"bwd_pkts"`
	FwdBytes       int64   `json:"fwd_bytes"`
	BwdBytes       int64   `json:"bwd_bytes"`
	FwdPktLenMin   float64 `json:"fwd_pkt_len_min"`
	FwdPktLenMax   float64 `json:"fwd_pkt_len_max"`
	FwdPktLenMean  float64 `json:"fwd_pkt_len_mean"`
	FwdPktLenStd   float64 `json:"fwd_pkt_len_std"`
	BwdPktLenMin   float64 `json:"bwd_pkt_len_min"`
	BwdPktLenMax   float64 `json:"bwd_pkt_len_max"`
	BwdPktLenMean  float64 `json:"bwd_pkt_len_mean"`
	BwdPktLenStd   float64 `json:"bwd_pkt_len_std"`
	FwdIATMean     float64 `json:"fwd_iat_mean"`
	FwdIATStd      float64 `json:"fwd_iat_std"`
	BwdIATMean     float64 `json:"bwd_iat_mean"`
	BwdIATStd      float64 `json:"bwd_iat_std"`

	// Derived Ratios
	FwdBwdByteRatio float64 `json:"fwd_bwd_byte_ratio"`
	FwdBwdPktRatio  float64 `json:"fwd_bwd_pkt_ratio"`

	// L7 SSH Features (from SSHSessionRecord)
	ClientSoftwareCat    string  `json:"client_software_cat"`
	HASSHKnownBad        bool    `json:"hassh_known_bad"`
	WeakAlgoFlag         bool    `json:"weak_algo_flag"`
	BannerScanFlag       bool    `json:"banner_scan_flag"`
	TcpToBannerMs        float64 `json:"tcp_to_banner_ms"`
	BannerToKexMs        float64 `json:"banner_to_kex_ms"`
	KexToNewKeysMs       float64 `json:"kex_to_newkeys_ms"`
	TotalDurationMs      float64 `json:"total_duration_ms"`
	PktsBeforeNewKeys    int     `json:"pkts_before_newkeys"`
	BytesBeforeNewKeys   int64   `json:"bytes_before_newkeys"`

	// Behavioral Aggregates (from Redis/BehavioralEngine)
	DstFailedSessions10m int `json:"dst_failed_sessions_10min"`
}

type pendingCorr struct {
	flowRec *FlowRecord
	sshRec  *SSHSessionRecord
	addedAt time.Time
}

// FlowCorrelator holds pending events and merges them when both sides arrive.
type FlowCorrelator struct {
	mu      sync.Mutex
	pending map[string]*pendingCorr // keyed by "SrcIP:SrcPort"
	OutCh   chan SSHFeatureVector
}

func NewFlowCorrelator() *FlowCorrelator {
	c := &FlowCorrelator{
		pending: make(map[string]*pendingCorr),
		OutCh:   make(chan SSHFeatureVector, 1000),
	}
	go c.cleanupLoop()
	return c
}

func (c *FlowCorrelator) getCorrKey(srcIP string, srcPort uint16) string {
	return fmt.Sprintf("%s:%d", srcIP, srcPort)
}

func (c *FlowCorrelator) AddFlowRecord(rec FlowRecord) {
	if rec.Protocol != "TCP" { // Or if it doesn't match SSH port
		return
	}
	key := c.getCorrKey(rec.SrcIP, rec.SrcPort)

	c.mu.Lock()
	defer c.mu.Unlock()

	p, exists := c.pending[key]
	if !exists {
		c.pending[key] = &pendingCorr{
			flowRec: &rec,
			addedAt: time.Now(),
		}
		return
	}

	p.flowRec = &rec
	if p.sshRec != nil {
		c.emitAndClear(key, p)
	}
}

func (c *FlowCorrelator) AddSSHSessionRecord(rec SSHSessionRecord) {
	key := c.getCorrKey(rec.SrcIP, rec.SrcPort)

	c.mu.Lock()
	defer c.mu.Unlock()

	p, exists := c.pending[key]
	if !exists {
		c.pending[key] = &pendingCorr{
			sshRec:  &rec,
			addedAt: time.Now(),
		}
		return
	}

	p.sshRec = &rec
	if p.flowRec != nil {
		c.emitAndClear(key, p)
	}
}

// emitAndClear merges the two records and emits them. Caller must hold c.mu.
func (c *FlowCorrelator) emitAndClear(key string, p *pendingCorr) {
	vec := BuildSSHFeatureVector(p.sshRec, p.flowRec)
	select {
	case c.OutCh <- vec:
	default:
	}
	delete(c.pending, key)
}

func (c *FlowCorrelator) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		c.mu.Lock()
		cutoff := time.Now().Add(-15 * time.Second)
		for k, p := range c.pending {
			if p.addedAt.Before(cutoff) {
				// Evict partial (fail-open)
				delete(c.pending, k)
			}
		}
		c.mu.Unlock()
	}
}
