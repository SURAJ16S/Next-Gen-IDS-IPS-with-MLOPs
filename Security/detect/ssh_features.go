// SPDX-License-Identifier: GPL-2.0
package detect

// BuildSSHFeatureVector merges L7 SSHSessionRecord and L4 FlowRecord into a single feature vector.
// It also fetches behavioral stats if available (e.g. from Redis or BehavioralEngine).
func BuildSSHFeatureVector(sshRec *SSHSessionRecord, flowRec *FlowRecord) SSHFeatureVector {
	vec := SSHFeatureVector{}

	if sshRec != nil {
		vec.ConnID = sshRec.ConnID
		vec.SrcIP = sshRec.SrcIP
		vec.DstIP = sshRec.DstIP // May be empty
		vec.SrcPort = sshRec.SrcPort
		vec.DstPort = sshRec.DstPort
		vec.ClientSoftwareCat = sshRec.ClientSoftware
		vec.HASSHKnownBad = sshRec.HASSHKnownBad
		vec.WeakAlgoFlag = sshRec.WeakAlgoFlag
		vec.BannerScanFlag = sshRec.BannerScanFlag

		vec.TcpToBannerMs = float64(sshRec.TcpToBannerDuration.Milliseconds())
		vec.BannerToKexMs = float64(sshRec.BannerToKexDuration.Milliseconds())
		vec.KexToNewKeysMs = float64(sshRec.KexToNewKeysDuration.Milliseconds())
		vec.TotalDurationMs = float64(sshRec.TotalDuration.Milliseconds())

		vec.PktsBeforeNewKeys = sshRec.PktsBeforeNewKeys
		vec.BytesBeforeNewKeys = sshRec.BytesBeforeNewKeys
	}

	if flowRec != nil {
		vec.FlowID = flowRec.FlowID
		if vec.SrcIP == "" {
			vec.SrcIP = flowRec.SrcIP
			vec.DstIP = flowRec.DstIP
			vec.SrcPort = flowRec.SrcPort
			vec.DstPort = flowRec.DstPort
		}
		vec.DurationMs = float64(flowRec.DurationMs)
		vec.FwdPkts = flowRec.TotalFwdPackets
		vec.BwdPkts = flowRec.TotalBwdPackets
		vec.FwdBytes = flowRec.TotalFwdBytes
		vec.BwdBytes = flowRec.TotalBwdBytes

		vec.FwdPktLenMin = flowRec.FwdPktSizeMin
		vec.FwdPktLenMax = flowRec.FwdPktSizeMax
		vec.FwdPktLenMean = flowRec.FwdPktSizeMean
		vec.FwdPktLenStd = flowRec.FwdPktSizeStd
		vec.BwdPktLenMin = flowRec.BwdPktSizeMin
		vec.BwdPktLenMax = flowRec.BwdPktSizeMax
		vec.BwdPktLenMean = flowRec.BwdPktSizeMean
		vec.BwdPktLenStd = flowRec.BwdPktSizeStd

		vec.FwdIATMean = flowRec.FwdIATMean
		vec.FwdIATStd = flowRec.FwdIATStd
		vec.BwdIATMean = flowRec.BwdIATMean
		vec.BwdIATStd = flowRec.BwdIATStd
	}

	// Calculate Derived Ratios safely
	if vec.BwdBytes > 0 {
		vec.FwdBwdByteRatio = float64(vec.FwdBytes) / float64(vec.BwdBytes)
	} else if vec.FwdBytes > 0 {
		vec.FwdBwdByteRatio = 999.0 // Sentinel for infinite
	}

	if vec.BwdPkts > 0 {
		vec.FwdBwdPktRatio = float64(vec.FwdPkts) / float64(vec.BwdPkts)
	} else if vec.FwdPkts > 0 {
		vec.FwdBwdPktRatio = 999.0
	}

	return vec
}
