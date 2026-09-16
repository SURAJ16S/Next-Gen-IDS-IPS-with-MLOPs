// SPDX-License-Identifier: GPL-2.0
// detect/dns_features.go — Feature builder for DNS Machine Learning model

package detect

import (
	"crypto/sha256"
	"encoding/hex"
	"expvar"
	"strings"
)

const DNSFeatureSchemaVersion = 1

// DNSFeatureVector represents a normalized DNS record combined with
// historical behavioral tracking context. It is schema-locked to
// DNS_FEATURE_COLUMNS in Python.
type DNSFeatureVector struct {
	SchemaVersion int `json:"schema_version"`

	// Stateless (per-query)
	DomainEntropy       float64 `json:"domain_entropy"`
	LabelCount          float64 `json:"label_count"`
	MaxLabelLength      float64 `json:"max_label_length"`
	SLDEntropy          float64 `json:"sld_entropy"`
	DigitRatio          float64 `json:"digit_ratio"`
	VowelConsonantRatio float64 `json:"vowel_consonant_ratio"`
	QueryLength         float64 `json:"query_length"`
	AnyQueryFlag        float64 `json:"any_query_flag"`

	// Behavioral (aggregates from behavioral.go)
	UncommonQtypeRatio1m  float64 `json:"uncommon_qtype_ratio_1m"`
	UncommonQtypeRatio10m float64 `json:"uncommon_qtype_ratio_10m"`
	NXDomainRatio10m      float64 `json:"nxdomain_ratio_10m"`
	UniqueSubdomainCount  float64 `json:"unique_subdomain_count"`
	RepeatabilityFactor   float64 `json:"repeatability_factor"`
	AvgResponseSizeEWMA   float64 `json:"avg_response_size_ewma"`

	// Metadata (not sent to ML, used for routing/logging)
	SrcIP      string `json:"src_ip"`
	ConnID     string `json:"conn_id"`
	DomainHash string `json:"domain_hash"`
}

// ExtractSLD returns the second-level domain from an FQDN, or empty string.
func ExtractSLD(fqdn string) string {
	parts := strings.Split(strings.Trim(fqdn, "."), ".")
	if len(parts) < 2 {
		return ""
	}
	return parts[len(parts)-2]
}

// ComputeMaxLabelLength finds the length of the longest label in the FQDN.
func ComputeMaxLabelLength(fqdn string) float64 {
	maxLen := 0
	for _, label := range strings.Split(fqdn, ".") {
		if len(label) > maxLen {
			maxLen = len(label)
		}
	}
	return float64(maxLen)
}

// ComputeDigitRatio returns the fraction of digits in the given string.
func ComputeDigitRatio(s string) float64 {
	if len(s) == 0 {
		return 0
	}
	digits := 0
	for _, c := range s {
		if c >= '0' && c <= '9' {
			digits++
		}
	}
	return float64(digits) / float64(len(s))
}

// ComputeVowelConsonantRatio returns (vowels / consonants), or 0 if no consonants.
func ComputeVowelConsonantRatio(s string) float64 {
	vowels := 0
	consonants := 0
	for _, c := range strings.ToLower(s) {
		if c >= 'a' && c <= 'z' {
			if c == 'a' || c == 'e' || c == 'i' || c == 'o' || c == 'u' {
				vowels++
			} else {
				consonants++
			}
		}
	}
	if consonants == 0 {
		return 0 // avoid div by zero
	}
	return float64(vowels) / float64(consonants)
}

// BuildDNSFeatureVector creates the full ML feature vector for a given query.
func BuildDNSFeatureVector(srcIP, connID, qname, qtype string, aggs DNSAggregates) DNSFeatureVector {
	domainEntropy := shannonEntropy(qname)
	labelCount := float64(len(strings.Split(qname, ".")))
	maxLabelLength := ComputeMaxLabelLength(qname)

	sld := ExtractSLD(qname)
	sldEntropy := 0.0
	if sld != "" {
		sldEntropy = shannonEntropy(sld)
	}

	digitRatio := ComputeDigitRatio(qname)
	vowelConsonantRatio := ComputeVowelConsonantRatio(qname)
	queryLength := float64(len(qname))
	
	anyQueryFlag := 0.0
	if qtype == "ANY" {
		anyQueryFlag = 1.0
	}

	return DNSFeatureVector{
		SchemaVersion: DNSFeatureSchemaVersion,
		SrcIP:         srcIP,
		ConnID:        connID,

		DomainEntropy:       domainEntropy,
		LabelCount:          labelCount,
		MaxLabelLength:      maxLabelLength,
		SLDEntropy:          sldEntropy,
		DigitRatio:          digitRatio,
		VowelConsonantRatio: vowelConsonantRatio,
		QueryLength:         queryLength,
		AnyQueryFlag:        anyQueryFlag,

		UncommonQtypeRatio1m:  aggs.UncommonQtypeRatio1m,
		UncommonQtypeRatio10m: aggs.UncommonQtypeRatio10m,
		NXDomainRatio10m:      aggs.NXDomainRatio10m,
		UniqueSubdomainCount:  aggs.UniqueSubdomainCount,
		RepeatabilityFactor:   aggs.RepeatabilityFactor,
		AvgResponseSizeEWMA:   aggs.AvgResponseSizeEWMA,
		DomainHash:            domainHash(qname),
	}
}

// domainHash creates a short SHA256 hex digest of the queried domain
func domainHash(qname string) string {
	h := sha256.Sum256([]byte(qname))
	return hex.EncodeToString(h[:16])
}

var DNSFeatureChan = make(chan DNSFeatureVector, 4096)
var DNSDropped = expvar.NewInt("dns_features_dropped")
