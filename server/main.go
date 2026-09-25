package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"time"
)

type selfAddressFlags []netip.Addr

func newHTTPServer(address string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              address,
		Handler:           handler,
		ReadTimeout:       30 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}

func (addresses *selfAddressFlags) String() string {
	values := make([]string, len(*addresses))
	for index, address := range *addresses {
		values[index] = address.String()
	}
	return strings.Join(values, ",")
}

func (addresses *selfAddressFlags) Set(value string) error {
	address, err := netip.ParseAddr(value)
	if err != nil || address.Zone() != "" || !publicAddress(address) {
		return fmt.Errorf("--self-address requires a public IP address")
	}
	*addresses = append(*addresses, address.Unmap())
	return nil
}

func main() {
	listen := flag.String("listen", ":443", "TCP listen address")
	cert := flag.String("cert", "", "TLS certificate PEM path")
	key := flag.String("key", "", "TLS private key PEM path")
	credentials := flag.String("credentials", "", "file containing username:password")
	selfHost := flag.String("self-host", "", "public hostname or IP used to reach this proxy")
	var extraSelf selfAddressFlags
	flag.Var(&extraSelf, "self-address", "additional public IP of this proxy (repeatable)")
	acmeOnly := flag.Bool("acme-only", false, "serve only HTTP-01 challenges")
	acmeWebroot := flag.String("acme-webroot", "", "Certbot webroot")
	flag.Parse()

	if *acmeOnly {
		if *acmeWebroot == "" {
			log.Fatal("--acme-webroot is required with --acme-only")
		}
		srv := newHTTPServer(*listen, acmeHandler(*acmeWebroot))
		srv.IdleTimeout = 30 * time.Second
		srv.MaxHeaderBytes = 8 << 10
		log.Printf("ACME HTTP-01 listener started on %s", *listen)
		log.Fatal(srv.ListenAndServe())
	}

	if *cert == "" || *key == "" || *credentials == "" || *selfHost == "" {
		log.Fatal("--cert, --key, --credentials and --self-host are required")
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
	proxy.selfHost = *selfHost
	proxy.extraSelf = extraSelf
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	_, err = proxy.selfAddresses(ctx)
	cancel()
	if err != nil {
		log.Fatal(err)
	}
	reloader, err := newCertificateReloader(*cert, *key)
	if err != nil {
		log.Fatal(err)
	}
	srv := newHTTPServer(*listen, proxy)
	srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, NextProtos: []string{"http/1.1"}, GetCertificate: reloader.getCertificate}
	srv.TLSNextProto = map[string]func(*http.Server, *tls.Conn, http.Handler){}
	log.Printf("HTTPS proxy listener started on %s", *listen)
	if err := srv.ListenAndServeTLS("", ""); err != nil {
		log.Fatal(fmt.Errorf("proxy listener: %w", err))
	}
}

func readCredentials(path string) (string, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", fmt.Errorf("read credentials: %w", err)
	}
	value := strings.TrimSuffix(string(data), "\r\n")
	value = strings.TrimSuffix(value, "\n")
	user, password, ok := strings.Cut(value, ":")
	if !ok || user == "" || password == "" || strings.ContainsAny(value, "\r\n") {
		return "", "", fmt.Errorf("invalid credentials file")
	}
	return user, password, nil
}
