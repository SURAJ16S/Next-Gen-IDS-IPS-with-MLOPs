package detect

import (
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestDNSFeatureVectorSchemaLock(t *testing.T) {
	// We read feature_encoder.py to ensure the struct tags match the python list
	data, err := os.ReadFile("../ML/feature_encoder.py")
	if err != nil {
		t.Skip("feature_encoder.py not found, skipping schema lock test")
	}

	content := string(data)
	start := strings.Index(content, "DNS_FEATURE_COLUMNS = [")
	if start == -1 {
		t.Fatal("DNS_FEATURE_COLUMNS not found in feature_encoder.py")
	}
	end := strings.Index(content[start:], "]")
	if end == -1 {
		t.Fatal("Could not find end of DNS_FEATURE_COLUMNS")
	}

	listStr := content[start : start+end]
	
	// Get struct tags
	typ := reflect.TypeOf(DNSFeatureVector{})
	var jsonTags []string
	for i := 0; i < typ.NumField(); i++ {
		tag := typ.Field(i).Tag.Get("json")
		if tag != "" && tag != "schema_version" && tag != "src_ip" && tag != "conn_id" && tag != "domain_hash" {
			jsonTags = append(jsonTags, tag)
		}
	}

	// Simple check: make sure all jsonTags exist in the python list
	for _, tag := range jsonTags {
		if !strings.Contains(listStr, `"`+tag+`"`) {
			t.Errorf("Schema drift: Go field %s not found in Python DNS_FEATURE_COLUMNS", tag)
		}
	}
}

func TestPureExtractionFunctions(t *testing.T) {
	// Base32 Tunneling
	fqdn := "base32.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tunnel.example.com"
	maxLen := ComputeMaxLabelLength(fqdn)
	if maxLen != 64 {
		t.Errorf("Expected max label length 64, got %v", maxLen)
	}
	
	// DGA (Bambenek-like)
	dga := "a1b2c3d4.jx7kp9.net"
	dr := ComputeDigitRatio(dga)
	if dr < 0.2 {
		t.Errorf("Expected digit ratio > 0.2 for %s, got %v", dga, dr)
	}

	// Dictionary DGA
	dict := "purplehouse.com"
	vcr := ComputeVowelConsonantRatio(dict)
	if math.IsNaN(vcr) || vcr == 0 {
		t.Errorf("Expected non-zero vowel consonant ratio for %s, got %v", dict, vcr)
	}
}
