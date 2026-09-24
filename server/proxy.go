package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

type proxyServer struct {
	authKey [sha256.Size]byte
	authTag [sha256.Size]byte
	lookup  func(context.Context, string) ([]netip.Addr, error)
	dial    func(context.Context, string) (net.Conn, error)
}

func newProxy(user, password string) (*proxyServer, error) {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	p := &proxyServer{
		lookup: func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		},
		dial: func(ctx context.Context, target string) (net.Conn, error) {
			return dialer.DialContext(ctx, "tcp", target)
		},
	}
	if _, err := rand.Read(p.authKey[:]); err != nil {
		return nil, fmt.Errorf("initialize proxy authentication: %w", err)
	}
	copy(p.authTag[:], p.authenticationTag([]byte(user+":"+password)))
	return p, nil
}

func (p *proxyServer) authenticationTag(credentials []byte) []byte {
	mac := hmac.New(sha256.New, p.authKey[:])
	_, _ = mac.Write(credentials)
	return mac.Sum(nil)
}

func (p *proxyServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !p.authorized(r.Header.Get("Proxy-Authorization")) {
		w.Header().Set("Proxy-Authenticate", `Basic realm="Self Hosted Browser VPN"`)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Length", "0")
		w.WriteHeader(http.StatusProxyAuthRequired)
		return
	}

	if r.Method == http.MethodConnect {
		p.connect(w, r)
		return
	}
	if r.URL == nil || r.URL.Scheme != "http" || r.URL.Host == "" || r.URL.User != nil {
		http.Error(w, "absolute HTTP URL required", http.StatusBadRequest)
		return
	}
	p.forwardHTTP(w, r)
}

func (p *proxyServer) authorized(header string) bool {
	scheme, encoded, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Basic") || len(encoded) > 1024 {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return false
	}
	return hmac.Equal(p.authenticationTag(decoded), p.authTag[:])
}

var allowedPorts = map[int]bool{80: true, 443: true, 8080: true, 8443: true, 9443: true}

func splitTarget(authority, defaultPort string) (string, string, error) {
	if authority == "" || strings.ContainsAny(authority, "@/#?\\\r\n\t ") {
		return "", "", errors.New("invalid target")
	}
	host := authority
	port := defaultPort
	if strings.HasPrefix(authority, "[") && strings.HasSuffix(authority, "]") && defaultPort != "" {
		host = strings.TrimSuffix(strings.TrimPrefix(authority, "["), "]")
	} else if strings.HasPrefix(authority, "[") || strings.Contains(authority, ":") {
		var err error
		host, port, err = net.SplitHostPort(authority)
		if err != nil {
			return "", "", errors.New("invalid target address")
		}
	}
	if host == "" || strings.HasSuffix(host, ".") && len(host) == 1 || strings.Contains(host, "%") {
		return "", "", errors.New("invalid target host")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", "", errors.New("invalid target port")
	}
	if !allowedPorts[n] {
		return "", "", errors.New("destination port is blocked")
	}
	return host, port, nil
}

// These ranges are non-public or can encode another address (for example, 6to4).
// IsGlobalUnicast alone intentionally does not reject all private ranges.
var blockedRanges = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
}

var publicIPv6 = netip.MustParsePrefix("2000::/3")

func publicAddress(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() {
		return false
	}
	if addr.Is6() && !publicIPv6.Contains(addr) {
		return false
	}
	for _, network := range blockedRanges {
		if network.Contains(addr) {
			return false
		}
	}
	return true
}

var errForbidden = errors.New("destination is not a public web address")

func (p *proxyServer) destinations(ctx context.Context, authority, defaultPort string) ([]string, error) {
	host, port, err := splitTarget(authority, defaultPort)
	if err != nil {
		return nil, err
	}
	if literal, parseErr := netip.ParseAddr(host); parseErr == nil {
		if !publicAddress(literal) {
			return nil, errForbidden
		}
		return []string{net.JoinHostPort(literal.Unmap().String(), port)}, nil
	}
	addrs, err := p.lookup(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("resolve destination: %w", err)
	}
	var targets []string
	for _, addr := range addrs {
		if publicAddress(addr) {
			targets = append(targets, net.JoinHostPort(addr.Unmap().String(), port))
		}
	}
	if len(targets) == 0 {
		return nil, errForbidden
	}
	return targets, nil
}

func (p *proxyServer) dialDestinations(ctx context.Context, targets []string) (net.Conn, error) {
	var lastErr error
	for _, target := range targets {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		connection, err := p.dial(ctx, target)
		if err == nil {
			return connection, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("connect to public destination: %w", lastErr)
}

func (p *proxyServer) connect(w http.ResponseWriter, r *http.Request) {
	targets, err := p.destinations(r.Context(), r.Host, "")
	if err != nil {
		writeDestinationError(w, err)
		return
	}
	upstream, err := p.dialDestinations(r.Context(), targets)
	if err != nil {
		http.Error(w, "upstream connection failed", http.StatusBadGateway)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		_ = upstream.Close()
		http.Error(w, "tunneling unavailable", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		_ = upstream.Close()
		return
	}
	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		_ = client.Close()
		_ = upstream.Close()
		return
	}
	done := make(chan struct{}, 2)
	// The HTTP parser can already have buffered part of the tunnel payload.
	go tunnelCopy(upstream, buffered, done)
	go tunnelCopy(client, upstream, done)
	<-done
	_ = client.Close()
	_ = upstream.Close()
	<-done
}

func tunnelCopy(dst net.Conn, src io.Reader, done chan<- struct{}) {
	_, _ = io.Copy(dst, src)
	if tcp, ok := dst.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
	}
	done <- struct{}{}
}

func (p *proxyServer) forwardHTTP(w http.ResponseWriter, r *http.Request) {
	targets, err := p.destinations(r.Context(), r.URL.Host, "80")
	if err != nil {
		writeDestinationError(w, err)
		return
	}
	upstream := r.Clone(r.Context())
	upstream.RequestURI = ""
	upstream.Host = r.URL.Host
	removeHopHeaders(upstream.Header)
	transport := &http.Transport{
		Proxy:                 nil,
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: 30 * time.Second,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return p.dialDestinations(ctx, targets)
		},
	}
	defer transport.CloseIdleConnections()
	response, err := transport.RoundTrip(upstream)
	if err != nil {
		http.Error(w, "upstream request failed", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	removeHopHeaders(response.Header)
	for name, values := range response.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, response.Body)
}

func removeHopHeaders(h http.Header) {
	for _, value := range h.Values("Connection") {
		for _, field := range strings.Split(value, ",") {
			h.Del(strings.TrimSpace(field))
		}
	}
	for _, name := range []string{
		"Connection", "Proxy-Connection", "Proxy-Authorization", "Proxy-Authenticate",
		"Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade",
	} {
		h.Del(name)
	}
}

func writeDestinationError(w http.ResponseWriter, err error) {
	if errors.Is(err, errForbidden) || strings.Contains(err.Error(), "blocked") {
		http.Error(w, "destination is blocked", http.StatusForbidden)
		return
	}
	if strings.HasPrefix(err.Error(), "resolve destination:") {
		http.Error(w, "destination lookup failed", http.StatusBadGateway)
		return
	}
	http.Error(w, "invalid destination", http.StatusBadRequest)
}
