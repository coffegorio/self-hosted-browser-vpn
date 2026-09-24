package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	listen := flag.String("listen", ":443", "TCP listen address")
	cert := flag.String("cert", "", "TLS certificate PEM path")
	key := flag.String("key", "", "TLS private key PEM path")
	credentials := flag.String("credentials", "", "file containing username:password")
	acmeOnly := flag.Bool("acme-only", false, "serve only HTTP-01 challenges")
	acmeWebroot := flag.String("acme-webroot", "", "Certbot webroot")
	flag.Parse()

	if *acmeOnly {
		if *acmeWebroot == "" {
			log.Fatal("--acme-webroot is required with --acme-only")
		}
		srv := &http.Server{
			Addr:              *listen,
			Handler:           acmeHandler(*acmeWebroot),
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       30 * time.Second,
			MaxHeaderBytes:    8 << 10,
		}
		log.Printf("ACME HTTP-01 listener started on %s", *listen)
		log.Fatal(srv.ListenAndServe())
	}

	if *cert == "" || *key == "" || *credentials == "" {
		log.Fatal("--cert, --key and --credentials are required")
	}
	user, password, err := readCredentials(*credentials)
	if err != nil {
		log.Fatal(err)
	}
	if strings.ContainsAny(*listen, "\r\n") {
		log.Fatal("invalid listen address")
	}
	proxy, err := newProxy(user, password)
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{
		Addr:              *listen,
		Handler:           proxy,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}},
		TLSNextProto:      map[string]func(*http.Server, *tls.Conn, http.Handler){},
	}
	log.Printf("HTTPS proxy listener started on %s", *listen)
	if err := srv.ListenAndServeTLS(*cert, *key); err != nil {
		log.Fatal(fmt.Errorf("proxy listener: %w", err))
	}
}

func readCredentials(path string) (string, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", fmt.Errorf("read credentials: %w", err)
	}
	value := strings.TrimSuffix(string(data), "\n")
	user, password, ok := strings.Cut(value, ":")
	if !ok || user == "" || password == "" || strings.ContainsAny(value, "\r\n") {
		return "", "", fmt.Errorf("invalid credentials file")
	}
	return user, password, nil
}
