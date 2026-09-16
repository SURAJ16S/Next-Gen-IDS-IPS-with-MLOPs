// SPDX-License-Identifier: GPL-2.0
// detect/flow_tracker.go — CICFlowMeter-style connection aggregation.
// Aggregates per-packet eBPF events into per-connection (flow) statistics
// suitable for ML-based intrusion detection models. Each flow record captures
// byte/packet counts, TCP flag tallies, timing features (IAT, burst, idle),
// and directional statistics.

package detect

import (
	"crypto/sha256"
	"fmt"
	"math"
	"sync"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// Flow Key — uniquely identifies a bidirectional network flow
// ──────────────────────────────────────────────────────────────────────────────

// FlowKey identifies a flow by its 5-tuple, canonicalized so that both
// directions of a connection map to the same key.
type FlowKey struct {
	SrcIP    string
	DstIP    string
	SrcPort  uint16
	DstPort  uint16
	Protocol string // "TCP" or "UDP"
}

// Canonical returns a FlowKey where the smaller IP:port is always "Src",
// ensuring both directions of a connection map to the same flow.
func (k FlowKey) Canonical() FlowKey {
	if k.SrcIP > k.DstIP || (k.SrcIP == k.DstIP && k.SrcPort > k.DstPort) {
		return FlowKey{
			SrcIP:    k.DstIP,
			DstIP:    k.SrcIP,
			SrcPort:  k.DstPort,
			DstPort:  k.SrcPort,
			Protocol: k.Protocol,
		}
	}
	return k
}

// ──────────────────────────────────────────────────────────────────────────────
// Flow Record — CICFlowMeter-compatible per-connection statistics
// ──────────────────────────────────────────────────────────────────────────────

// FlowRecord holds aggregated statistics for a single network flow.
// Field names align with the CIC-IDS2017/2018 feature schema so that
// downstream ML pipelines can ingest them directly.
type FlowRecord struct {
	// ── Identity ──
	FlowID   string `json:"flow_id"`
	SrcIP    string `json:"src_ip"`
	DstIP    string `json:"dst_ip"`
	SrcPort  uint16 `json:"src_port"`
	DstPort  uint16 `json:"dst_port"`
	Protocol string `json:"protocol"`

	// ── Timing ──
	StartTime  time.Time `json:"start_time"`
	EndTime    time.Time `json:"end_time"`
	DurationMs float64   `json:"duration_ms"`

	// ── Packet Counts ──
	TotalFwdPackets int64 `json:"total_fwd_packets"` // Client → Server
	TotalBwdPackets int64 `json:"total_bwd_packets"` // Server → Client
	TotalPackets    int64 `json:"total_packets"`

	// ── Byte Counts ──
	TotalFwdBytes int64 `json:"total_fwd_bytes"`
	TotalBwdBytes int64 `json:"total_bwd_bytes"`
	TotalBytes    int64 `json:"total_bytes"`

	// ── Packet Size Statistics ──
	FwdPktSizeMax  float64 `json:"fwd_pkt_len_max"`
	FwdPktSizeMin  float64 `json:"fwd_pkt_len_min"`
	FwdPktSizeMean float64 `json:"fwd_pkt_len_mean"`
	FwdPktSizeStd  float64 `json:"fwd_pkt_len_std"`
	BwdPktSizeMax  float64 `json:"bwd_pkt_len_max"`
	BwdPktSizeMin  float64 `json:"bwd_pkt_len_min"`
	BwdPktSizeMean float64 `json:"bwd_pkt_len_mean"`
	BwdPktSizeStd  float64 `json:"bwd_pkt_len_std"`

	// ── TCP Flag Counts ──
	SYNCount int64 `json:"syn_count"`
	ACKCount int64 `json:"ack_count"`
	FINCount int64 `json:"fin_count"`
	RSTCount int64 `json:"rst_count"`
	PSHCount int64 `json:"psh_count"`
	URGCount int64 `json:"urg_count"`

	// ── Timing Features ──
	FlowPktsPerSec  float64 `json:"flow_pkts_per_sec"`
	FlowBytesPerSec float64 `json:"flow_bytes_per_sec"`

	// ── Inter-Arrival Time (IAT) — Forward ──
	FwdIATMean float64 `json:"fwd_iat_mean_ms"`
	FwdIATStd  float64 `json:"fwd_iat_std_ms"`
	FwdIATMax  float64 `json:"fwd_iat_max_ms"`
	FwdIATMin  float64 `json:"fwd_iat_min_ms"`

	// ── Inter-Arrival Time (IAT) — Backward ──
	BwdIATMean float64 `json:"bwd_iat_mean_ms"`
	BwdIATStd  float64 `json:"bwd_iat_std_ms"`
	BwdIATMax  float64 `json:"bwd_iat_max_ms"`
	BwdIATMin  float64 `json:"bwd_iat_min_ms"`

	// ── Active/Idle Times ──
	ActiveMean float64 `json:"active_mean_ms"`
	ActiveStd  float64 `json:"active_std_ms"`
	ActiveMax  float64 `json:"active_max_ms"`
	ActiveMin  float64 `json:"active_min_ms"`
	IdleMean   float64 `json:"idle_mean_ms"`
	IdleStd    float64 `json:"idle_std_ms"`
	IdleMax    float64 `json:"idle_max_ms"`
	IdleMin    float64 `json:"idle_min_ms"`
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal mutable flow state
// ──────────────────────────────────────────────────────────────────────────────

// flowState is the internal mutable state used to accumulate per-packet data.
type flowState struct {
	key FlowKey
	flowID string

	startTime time.Time
	lastSeen  time.Time

	// Forward (initiator → responder)
	fwdPackets    int64
	fwdBytes      int64
	fwdSizes      []float64 // Individual packet sizes for std calculation
	fwdTimestamps []time.Time

	// Backward (responder → initiator)
	bwdPackets    int64
	bwdBytes      int64
	bwdSizes      []float64
	bwdTimestamps []time.Time

	// TCP flags (combined from both directions)
	synCount int64
	ackCount int64
	finCount int64
	rstCount int64
	pshCount int64
	urgCount int64

	// For active/idle calculation
	allTimestamps []time.Time

	// The original "initiator" IP used to determine direction
	initiatorIP   string
	initiatorPort uint16
}

// isForward returns true if this packet travels in the same direction
// as the connection initiator (client → server).
func (fs *flowState) isForward(srcIP string, srcPort uint16) bool {
	return srcIP == fs.initiatorIP && srcPort == fs.initiatorPort
}

// ──────────────────────────────────────────────────────────────────────────────
// FlowTracker — manages active flows and emits completed FlowRecords
// ──────────────────────────────────────────────────────────────────────────────

// FlowTracker aggregates per-packet events into per-flow statistics.
type FlowTracker struct {
	mu       sync.Mutex
	flows    map[FlowKey]*flowState
	maxFlows int

	// Channel to emit completed flow records
	completedCh chan FlowRecord

	// Idle timeout after which a flow is considered complete
	idleTimeout time.Duration
}

// NewFlowTracker creates a FlowTracker with the given capacity.
func NewFlowTracker(maxFlows int, idleTimeout time.Duration) *FlowTracker {
	if maxFlows <= 0 {
		maxFlows = 10000
	}
	if idleTimeout <= 0 {
		idleTimeout = 120 * time.Second
	}
	return &FlowTracker{
		flows:       make(map[FlowKey]*flowState),
		maxFlows:    maxFlows,
		completedCh: make(chan FlowRecord, 256),
		idleTimeout: idleTimeout,
	}
}

// CompletedFlows returns the channel on which completed FlowRecords are sent.
func (ft *FlowTracker) CompletedFlows() <-chan FlowRecord {
	return ft.completedCh
}

// PacketEvent represents a single packet from the eBPF layer.
type PacketEvent struct {
	Timestamp time.Time
	SrcIP     string
	DstIP     string
	SrcPort   uint16
	DstPort   uint16
	Protocol  string // "TCP" or "UDP"
	Size      uint16
	TCPFlags  uint8  // Raw bitmask
	Direction string // "INCOMING" or "OUTGOING"
}

// TrackPacket processes a single packet event and updates the flow state.
func (ft *FlowTracker) TrackPacket(pkt PacketEvent) {
	key := FlowKey{
		SrcIP:    pkt.SrcIP,
		DstIP:    pkt.DstIP,
		SrcPort:  pkt.SrcPort,
		DstPort:  pkt.DstPort,
		Protocol: pkt.Protocol,
	}.Canonical()

	ft.mu.Lock()
	defer ft.mu.Unlock()

	fs, exists := ft.flows[key]
	if !exists {
		// Check capacity
		if len(ft.flows) >= ft.maxFlows {
			ft.evictOldest()
		}
		
		hashInput := fmt.Sprintf("%s|%d|%s|%d|%s|%d", key.SrcIP, key.SrcPort, key.DstIP, key.DstPort, key.Protocol, pkt.Timestamp.UnixNano())
		hashBytes := sha256.Sum256([]byte(hashInput))
		
		fs = &flowState{
			key:           key,
			flowID:        fmt.Sprintf("%x", hashBytes)[:16],
			startTime:     pkt.Timestamp,
			initiatorIP:   pkt.SrcIP,
			initiatorPort: pkt.SrcPort,
		}
		ft.flows[key] = fs
	}

	fs.lastSeen = pkt.Timestamp
	fs.allTimestamps = append(fs.allTimestamps, pkt.Timestamp)

	// Direction classification
	if fs.isForward(pkt.SrcIP, pkt.SrcPort) {
		fs.fwdPackets++
		fs.fwdBytes += int64(pkt.Size)
		fs.fwdSizes = append(fs.fwdSizes, float64(pkt.Size))
		fs.fwdTimestamps = append(fs.fwdTimestamps, pkt.Timestamp)
	} else {
		fs.bwdPackets++
		fs.bwdBytes += int64(pkt.Size)
		fs.bwdSizes = append(fs.bwdSizes, float64(pkt.Size))
		fs.bwdTimestamps = append(fs.bwdTimestamps, pkt.Timestamp)
	}

	// TCP flag tallies
	if pkt.TCPFlags&0x02 != 0 {
		fs.synCount++
	}
	if pkt.TCPFlags&0x10 != 0 {
		fs.ackCount++
	}
	if pkt.TCPFlags&0x01 != 0 {
		fs.finCount++
	}
	if pkt.TCPFlags&0x04 != 0 {
		fs.rstCount++
	}
	if pkt.TCPFlags&0x08 != 0 {
		fs.pshCount++
	}
	if pkt.TCPFlags&0x20 != 0 {
		fs.urgCount++
	}

	// Check if connection is closed (FIN or RST seen from both sides, or RST)
	if pkt.TCPFlags&0x04 != 0 { // RST → immediate close
		record := ft.finalize(fs)
		delete(ft.flows, key)
		ft.emitAsync(record)
	} else if fs.finCount >= 2 { // FIN from both sides
		record := ft.finalize(fs)
		delete(ft.flows, key)
		ft.emitAsync(record)
	}
}

// Sweep checks for and emits flows that have been idle beyond the timeout.
// Should be called periodically (e.g., every 30 seconds).
func (ft *FlowTracker) Sweep() {
	ft.mu.Lock()
	defer ft.mu.Unlock()

	now := time.Now()
	for key, fs := range ft.flows {
		if now.Sub(fs.lastSeen) > ft.idleTimeout {
			record := ft.finalize(fs)
			delete(ft.flows, key)
			ft.emitAsync(record)
		}
	}
}

// FlushAll finalizes and emits all remaining flows. Call on shutdown.
func (ft *FlowTracker) FlushAll() {
	ft.mu.Lock()
	defer ft.mu.Unlock()

	for key, fs := range ft.flows {
		record := ft.finalize(fs)
		delete(ft.flows, key)
		ft.emitAsync(record)
	}
}

// ActiveFlows returns the number of currently tracked flows.
func (ft *FlowTracker) ActiveFlows() int {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return len(ft.flows)
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

// finalize converts a mutable flowState into an immutable FlowRecord.
// Must be called with ft.mu held.
func (ft *FlowTracker) finalize(fs *flowState) FlowRecord {
	duration := fs.lastSeen.Sub(fs.startTime)
	durationMs := float64(duration.Microseconds()) / 1000.0

	totalPackets := fs.fwdPackets + fs.bwdPackets
	totalBytes := fs.fwdBytes + fs.bwdBytes

	durationSec := duration.Seconds()
	pktsPerSec := 0.0
	bytesPerSec := 0.0
	if durationSec > 0 {
		pktsPerSec = float64(totalPackets) / durationSec
		bytesPerSec = float64(totalBytes) / durationSec
	}

	// Compute active/idle periods
	activePeriods, idlePeriods := computeActiveIdle(fs.allTimestamps, 1*time.Second)

	rec := FlowRecord{
		FlowID:     fs.flowID,
		SrcIP:      fs.key.SrcIP,
		DstIP:      fs.key.DstIP,
		SrcPort:    fs.key.SrcPort,
		DstPort:    fs.key.DstPort,
		Protocol:   fs.key.Protocol,
		StartTime:  fs.startTime,
		EndTime:    fs.lastSeen,
		DurationMs: durationMs,

		TotalFwdPackets: fs.fwdPackets,
		TotalBwdPackets: fs.bwdPackets,
		TotalPackets:    totalPackets,

		TotalFwdBytes: fs.fwdBytes,
		TotalBwdBytes: fs.bwdBytes,
		TotalBytes:    totalBytes,

		FwdPktSizeMax:  sliceMax(fs.fwdSizes),
		FwdPktSizeMin:  sliceMin(fs.fwdSizes),
		FwdPktSizeMean: sliceMean(fs.fwdSizes),
		FwdPktSizeStd:  sliceStd(fs.fwdSizes),
		BwdPktSizeMax:  sliceMax(fs.bwdSizes),
		BwdPktSizeMin:  sliceMin(fs.bwdSizes),
		BwdPktSizeMean: sliceMean(fs.bwdSizes),
		BwdPktSizeStd:  sliceStd(fs.bwdSizes),

		SYNCount: fs.synCount,
		ACKCount: fs.ackCount,
		FINCount: fs.finCount,
		RSTCount: fs.rstCount,
		PSHCount: fs.pshCount,
		URGCount: fs.urgCount,

		FlowPktsPerSec:  pktsPerSec,
		FlowBytesPerSec: bytesPerSec,

		FwdIATMean: iatMean(fs.fwdTimestamps),
		FwdIATStd:  iatStd(fs.fwdTimestamps),
		FwdIATMax:  iatMax(fs.fwdTimestamps),
		FwdIATMin:  iatMin(fs.fwdTimestamps),

		BwdIATMean: iatMean(fs.bwdTimestamps),
		BwdIATStd:  iatStd(fs.bwdTimestamps),
		BwdIATMax:  iatMax(fs.bwdTimestamps),
		BwdIATMin:  iatMin(fs.bwdTimestamps),

		ActiveMean: sliceMean(activePeriods),
		ActiveStd:  sliceStd(activePeriods),
		ActiveMax:  sliceMax(activePeriods),
		ActiveMin:  sliceMin(activePeriods),
		IdleMean:   sliceMean(idlePeriods),
		IdleStd:    sliceStd(idlePeriods),
		IdleMax:    sliceMax(idlePeriods),
		IdleMin:    sliceMin(idlePeriods),
	}
	return rec
}

// emitAsync sends a completed flow record to the channel without blocking.
func (ft *FlowTracker) emitAsync(rec FlowRecord) {
	select {
	case ft.completedCh <- rec:
	default:
		// Channel full; drop record to avoid blocking the packet path
	}
}

// evictOldest removes the flow with the oldest lastSeen timestamp.
func (ft *FlowTracker) evictOldest() {
	var oldestKey FlowKey
	var oldestTime time.Time
	first := true
	for key, fs := range ft.flows {
		if first || fs.lastSeen.Before(oldestTime) {
			oldestKey = key
			oldestTime = fs.lastSeen
			first = false
		}
	}
	if !first {
		record := ft.finalize(ft.flows[oldestKey])
		delete(ft.flows, oldestKey)
		ft.emitAsync(record)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Math helpers
// ──────────────────────────────────────────────────────────────────────────────

func sliceMax(s []float64) float64 {
	if len(s) == 0 {
		return 0
	}
	m := s[0]
	for _, v := range s[1:] {
		if v > m {
			m = v
		}
	}
	return m
}

func sliceMin(s []float64) float64 {
	if len(s) == 0 {
		return 0
	}
	m := s[0]
	for _, v := range s[1:] {
		if v < m {
			m = v
		}
	}
	return m
}

func sliceMean(s []float64) float64 {
	if len(s) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range s {
		sum += v
	}
	return sum / float64(len(s))
}

func sliceStd(s []float64) float64 {
	if len(s) < 2 {
		return 0
	}
	mean := sliceMean(s)
	sumSq := 0.0
	for _, v := range s {
		d := v - mean
		sumSq += d * d
	}
	return math.Sqrt(sumSq / float64(len(s)-1))
}

// iatMean computes the mean inter-arrival time in milliseconds.
func iatMean(timestamps []time.Time) float64 {
	intervals := computeIATs(timestamps)
	return sliceMean(intervals)
}

func iatStd(timestamps []time.Time) float64 {
	intervals := computeIATs(timestamps)
	return sliceStd(intervals)
}

func iatMax(timestamps []time.Time) float64 {
	intervals := computeIATs(timestamps)
	return sliceMax(intervals)
}

func iatMin(timestamps []time.Time) float64 {
	intervals := computeIATs(timestamps)
	return sliceMin(intervals)
}

// computeIATs returns inter-arrival times in milliseconds.
func computeIATs(timestamps []time.Time) []float64 {
	if len(timestamps) < 2 {
		return nil
	}
	iats := make([]float64, 0, len(timestamps)-1)
	for i := 1; i < len(timestamps); i++ {
		dt := timestamps[i].Sub(timestamps[i-1])
		iats = append(iats, float64(dt.Microseconds())/1000.0)
	}
	return iats
}

// computeActiveIdle separates the flow into active and idle periods.
// A gap longer than idleThreshold is considered idle time.
func computeActiveIdle(timestamps []time.Time, idleThreshold time.Duration) (active []float64, idle []float64) {
	if len(timestamps) < 2 {
		return nil, nil
	}

	currentActiveStart := timestamps[0]
	for i := 1; i < len(timestamps); i++ {
		gap := timestamps[i].Sub(timestamps[i-1])
		if gap > idleThreshold {
			// End of active period → record it
			activeDur := timestamps[i-1].Sub(currentActiveStart)
			if activeDur > 0 {
				active = append(active, float64(activeDur.Microseconds())/1000.0)
			}
			// The gap itself is an idle period
			idle = append(idle, float64(gap.Microseconds())/1000.0)
			// New active period starts at current timestamp
			currentActiveStart = timestamps[i]
		}
	}
	// Final active period
	lastActive := timestamps[len(timestamps)-1].Sub(currentActiveStart)
	if lastActive > 0 {
		active = append(active, float64(lastActive.Microseconds())/1000.0)
	}

	return active, idle
}

// itoa converts a uint16 to a string without importing strconv.
func itoa(n uint16) string {
	if n == 0 {
		return "0"
	}
	buf := make([]byte, 0, 5)
	for n > 0 {
		buf = append(buf, byte('0'+n%10))
		n /= 10
	}
	// Reverse
	for i, j := 0, len(buf)-1; i < j; i, j = i+1, j-1 {
		buf[i], buf[j] = buf[j], buf[i]
	}
	return string(buf)
}
