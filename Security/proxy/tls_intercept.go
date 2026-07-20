// SPDX-License-Identifier: GPL-2.0
// proxy/tls_intercept.go — TLS MITM interception with on-the-fly certificate
// generation. Creates a self-signed CA on first run and generates certificates
// for each SNI hostname to enable encrypted traffic inspection.

package proxy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ──────────────────────────────────────────────────────────────────────────────
// TLS Interceptor
// ──────────────────────────────────────────────────────────────────────────────

// TLSInterceptor performs TLS MITM for encrypted traffic inspection.
type TLSInterceptor struct {
	caCert    *x509.Certificate
	caKey     *ecdsa.PrivateKey
	certCache sync.Map // hostname → *tls.Certificate
	maxCache  int
}

// NewTLSInterceptor loads or creates a CA and sets up the interceptor.
func NewTLSInterceptor(certDir string, maxCache int) (*TLSInterceptor, error) {
	if maxCache <= 0 {
		maxCache = 1000
	}

	if err := os.MkdirAll(certDir, 0700); err != nil {
		return nil, fmt.Errorf("create cert dir: %w", err)
	}

	certPath := filepath.Join(certDir, "ca.crt")
	keyPath := filepath.Join(certDir, "ca.key")

	var caCert *x509.Certificate
	var caKey *ecdsa.PrivateKey

	// Try to load existing CA
	if _, err := os.Stat(certPath); err == nil {
		caCert, caKey, err = loadCA(certPath, keyPath)
		if err != nil {
			return nil, fmt.Errorf("load CA: %w", err)
		}
	} else {
		// Generate new CA
		caCert, caKey, err = generateCA(certPath, keyPath)
		if err != nil {
			return nil, fmt.Errorf("generate CA: %w", err)
		}
	}

	return &TLSInterceptor{
		caCert:   caCert,
		caKey:    caKey,
		maxCache: maxCache,
	}, nil
}

// GetCertificate returns a TLS certificate for the given hostname.
// Generates one on-the-fly if not cached.
func (ti *TLSInterceptor) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	hostname := hello.ServerName
	if hostname == "" {
		hostname = "unknown"
	}

	// Check cache
	if cached, ok := ti.certCache.Load(hostname); ok {
		return cached.(*tls.Certificate), nil
	}

	// Generate new certificate
	cert, err := ti.generateCert(hostname)
	if err != nil {
		return nil, fmt.Errorf("generate cert for %s: %w", hostname, err)
	}

	ti.certCache.Store(hostname, cert)
	return cert, nil
}

// TLSConfig returns a tls.Config suitable for the proxy listener.
func (ti *TLSInterceptor) TLSConfig() *tls.Config {
	return &tls.Config{
		GetCertificate: ti.GetCertificate,
		MinVersion:     tls.VersionTLS12,
	}
}

// CACertPEM returns the CA certificate in PEM format (for client trust setup).
func (ti *TLSInterceptor) CACertPEM() []byte {
	return pem.EncodeToMemory(&pem.Block{
		Type:  "CERTIFICATE",
		Bytes: ti.caCert.Raw,
	})
}

// generateCert creates a TLS certificate for the given hostname, signed by the CA.
func (ti *TLSInterceptor) generateCert(hostname string) (*tls.Certificate, error) {
	// Generate key
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	// Serial number
	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}

	template := &x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"NGFW Proxy"},
			CommonName:   hostname,
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{hostname},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, ti.caCert, &key.PublicKey, ti.caKey)
	if err != nil {
		return nil, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	tlsCert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, err
	}

	return &tlsCert, nil
}

// ──────────────────────────────────────────────────────────────────────────────
// CA Generation and Loading
// ──────────────────────────────────────────────────────────────────────────────

func generateCA(certPath, keyPath string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	// Generate CA private key
	caKey, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("generate CA key: %w", err)
	}

	// Serial number
	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, err
	}

	// CA certificate template
	caTemplate := &x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"NGFW Next-Gen Firewall"},
			CommonName:   "NGFW Proxy CA",
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour), // 10 years
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
	}

	// Self-sign
	caCertDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, fmt.Errorf("create CA cert: %w", err)
	}

	caCert, err := x509.ParseCertificate(caCertDER)
	if err != nil {
		return nil, nil, fmt.Errorf("parse CA cert: %w", err)
	}

	// Write cert to file
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caCertDER})
	if err := os.WriteFile(certPath, certPEM, 0644); err != nil {
		return nil, nil, fmt.Errorf("write CA cert: %w", err)
	}

	// Write key to file
	keyDER, err := x509.MarshalECPrivateKey(caKey)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal CA key: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(keyPath, keyPEM, 0600); err != nil {
		return nil, nil, fmt.Errorf("write CA key: %w", err)
	}

	return caCert, caKey, nil
}

func loadCA(certPath, keyPath string) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	// Read cert
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read CA cert: %w", err)
	}
	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil {
		return nil, nil, fmt.Errorf("invalid CA cert PEM")
	}
	caCert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse CA cert: %w", err)
	}

	// Read key
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read CA key: %w", err)
	}
	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, nil, fmt.Errorf("invalid CA key PEM")
	}
	caKey, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("parse CA key: %w", err)
	}

	return caCert, caKey, nil
}
