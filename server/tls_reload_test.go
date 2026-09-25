package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testCertificatePair(t *testing.T, serial int64) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial),
		Subject:      pkix.Name{CommonName: "proxy.test"},
		DNSNames:     []string{"proxy.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: privateKey})
}

func TestCertificateReloaderServesRotationAndRetainsLastGoodPair(t *testing.T) {
	directory := t.TempDir()
	certPath := filepath.Join(directory, "fullchain.pem")
	keyPath := filepath.Join(directory, "privkey.pem")
	write := func(path string, data []byte) {
		t.Helper()
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	firstCert, firstKey := testCertificatePair(t, 1)
	secondCert, secondKey := testCertificatePair(t, 2)
	write(certPath, firstCert)
	write(keyPath, firstKey)
	reloader, err := newCertificateReloader(certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{
		Handler:      http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }),
		TLSConfig:    &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: reloader.getCertificate},
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
	}
	finished := make(chan error, 1)
	go func() { finished <- server.ServeTLS(listener, "", "") }()
	t.Cleanup(func() {
		_ = server.Close()
		if err := <-finished; err != http.ErrServerClosed {
			t.Errorf("TLS server stopped: %v", err)
		}
	})
	servedSerial := func(serverName string) int64 {
		t.Helper()
		connection, err := tls.DialWithDialer(&net.Dialer{Timeout: time.Second}, "tcp", listener.Addr().String(), &tls.Config{
			InsecureSkipVerify: true, // Self-signed local test certificates.
			ServerName:         serverName,
		})
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		return connection.ConnectionState().PeerCertificates[0].SerialNumber.Int64()
	}
	if got := servedSerial("proxy.test"); got != 1 {
		t.Fatalf("initial certificate serial = %d, want 1", got)
	}
	// A non-SNI handshake must use the same callback. IP addresses do not send SNI.
	if got := servedSerial("127.0.0.1"); got != 1 {
		t.Fatalf("IP handshake certificate serial = %d, want 1", got)
	}

	// Certbot can replace the two symlink targets at different instants.
	write(certPath, secondCert)
	if got := servedSerial("proxy.test"); got != 1 {
		t.Fatalf("mismatched pair certificate serial = %d, want 1", got)
	}
	if reloader.lastFailure == "" {
		t.Fatal("failed reload was not recorded for diagnostics")
	}
	write(keyPath, secondKey)
	if got := servedSerial("127.0.0.1"); got != 2 {
		t.Fatalf("rotated certificate serial = %d, want 2", got)
	}
	if reloader.lastFailure != "" {
		t.Fatalf("diagnostic remained after recovery: %q", reloader.lastFailure)
	}

	write(certPath, []byte("invalid PEM"))
	if got := servedSerial("proxy.test"); got != 2 {
		t.Fatalf("malformed replacement certificate serial = %d, want 2", got)
	}
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	if got := servedSerial("proxy.test"); got != 2 {
		t.Fatalf("missing key certificate serial = %d, want 2", got)
	}
	write(certPath, secondCert)
	write(keyPath, secondKey)
	if got := servedSerial("proxy.test"); got != 2 {
		t.Fatalf("restored certificate serial = %d, want 2", got)
	}
	if reloader.lastFailure != "" {
		t.Fatalf("diagnostic remained after restoring files: %q", reloader.lastFailure)
	}
}

func TestCertificateReloaderRequiresValidStartupPair(t *testing.T) {
	directory := t.TempDir()
	certPath := filepath.Join(directory, "fullchain.pem")
	keyPath := filepath.Join(directory, "privkey.pem")
	if _, err := newCertificateReloader(certPath, keyPath); err == nil || !strings.Contains(err.Error(), "read certificate") {
		t.Fatalf("missing startup certificate error = %v", err)
	}
	if err := os.WriteFile(certPath, []byte("not a certificate"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte("not a key"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := newCertificateReloader(certPath, keyPath); err == nil || !strings.Contains(err.Error(), "parse TLS certificate") {
		t.Fatalf("invalid startup pair error = %v", err)
	}
}

func TestReadCredentialsAllowsSingleLFOrCRLF(t *testing.T) {
	for _, test := range []struct {
		name  string
		value string
		valid bool
	}{
		{"no line ending", "browser:secret", true},
		{"LF", "browser:secret\n", true},
		{"CRLF", "browser:secret\r\n", true},
		{"embedded line break", "browser:secret\r\nother:secret", false},
		{"two line breaks", "browser:secret\r\n\r\n", false},
		{"empty password", "browser:\r\n", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "credentials")
			if err := os.WriteFile(path, []byte(test.value), 0600); err != nil {
				t.Fatal(err)
			}
			user, password, err := readCredentials(path)
			if test.valid && (err != nil || user != "browser" || password != "secret") {
				t.Fatalf("readCredentials = %q, %q, %v", user, password, err)
			}
			if !test.valid && err == nil {
				t.Fatalf("accepted invalid credentials %q", test.value)
			}
		})
	}
}
