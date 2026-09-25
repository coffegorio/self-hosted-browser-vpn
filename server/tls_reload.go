package main

import (
	"crypto/sha256"
	"crypto/tls"
	"fmt"
	"log"
	"os"
	"sync"
)

type certificateFiles struct {
	certificate [sha256.Size]byte
	privateKey  [sha256.Size]byte
}

// certificateReloader publishes only complete, matching certificate/key pairs.
// The published certificate is never mutated after a handshake receives it.
type certificateReloader struct {
	mu          sync.Mutex
	certPath    string
	keyPath     string
	files       certificateFiles
	certificate *tls.Certificate
	lastFailure string
}

func newCertificateReloader(certPath, keyPath string) (*certificateReloader, error) {
	reloader := &certificateReloader{certPath: certPath, keyPath: keyPath}
	if _, err := reloader.reload(); err != nil {
		return nil, fmt.Errorf("load TLS certificate: %w", err)
	}
	return reloader, nil
}

func (reloader *certificateReloader) getCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	reloader.mu.Lock()
	defer reloader.mu.Unlock()

	changed, err := reloader.reload()
	if err != nil {
		if failure := err.Error(); failure != reloader.lastFailure {
			log.Printf("TLS certificate reload failed; serving last valid certificate: %v", err)
			reloader.lastFailure = failure
		}
	} else {
		if changed {
			log.Printf("TLS certificate reloaded from %s", reloader.certPath)
		}
		reloader.lastFailure = ""
	}
	return reloader.certificate, nil
}

// reload must be called while mu is held, except before the reloader is shared.
func (reloader *certificateReloader) reload() (bool, error) {
	certPEM, err := os.ReadFile(reloader.certPath)
	if err != nil {
		return false, fmt.Errorf("read certificate %s: %w", reloader.certPath, err)
	}
	keyPEM, err := os.ReadFile(reloader.keyPath)
	if err != nil {
		return false, fmt.Errorf("read private key %s: %w", reloader.keyPath, err)
	}
	fingerprint := certificateFiles{certificate: sha256.Sum256(certPEM), privateKey: sha256.Sum256(keyPEM)}
	if reloader.certificate != nil && fingerprint == reloader.files {
		return false, nil
	}
	certificate, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return false, fmt.Errorf("parse TLS certificate and key: %w", err)
	}
	reloader.certificate = &certificate
	reloader.files = fingerprint
	return true, nil
}
