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
	"sync"
	"time"
)

type proxyServer struct {
	authKey        [sha256.Size]byte
	authTag        [sha256.Size]byte
	selfHost       string
	extraSelf      []netip.Addr
	selfMu         sync.Mutex
	selfResolved   map[netip.Addr]struct{}
	selfRetryAfter time.Time
	localAddresses func() ([]netip.Addr, error)
	lookup         func(context.Context, string) ([]netip.Addr, error)
	dial           func(context.Context, string) (net.Conn, error)
}

func newProxy(user, password string) (*proxyServer, error) {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	p := &proxyServer{
		localAddresses: interfaceAddresses,
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

	// The server bounds unauthenticated body reads, including net/http's cleanup.
	// Once authenticated, preserve long uploads and full-duplex tunnels.
	if err := http.NewResponseController(w).SetReadDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
		http.Error(w, "could not prepare authenticated connection", http.StatusInternalServerError)
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
var errSelfUnavailable = errors.New("proxy address guard is unavailable")

func interfaceAddresses() ([]netip.Addr, error) {
	interfaces, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	var addresses []netip.Addr
	for _, entry := range interfaces {
		var ip net.IP
		switch value := entry.(type) {
		case *net.IPNet:
			ip = value.IP
		case *net.IPAddr:
			ip = value.IP
		}
		if address, ok := netip.AddrFromSlice(ip); ok {
			addresses = append(addresses, address.Unmap())
		}
	}
	return addresses, nil
}

func (p *proxyServer) selfAddresses(ctx context.Context) (map[netip.Addr]struct{}, error) {
	self := make(map[netip.Addr]struct{})
	for _, address := range p.extraSelf {
		self[address.Unmap()] = struct{}{}
	}
	if p.selfHost != "" {
		if address, err := netip.ParseAddr(p.selfHost); err == nil {
			self[address.Unmap()] = struct{}{}
		} else {
			p.selfMu.Lock()
			shouldLookup := len(p.selfResolved) == 0 || !time.Now().Before(p.selfRetryAfter)
			p.selfMu.Unlock()
			var lookupErr error
			if shouldLookup {
				addresses, err := p.lookup(ctx, p.selfHost)
				lookupErr = err
				p.selfMu.Lock()
				if err == nil {
					if p.selfResolved == nil {
						p.selfResolved = make(map[netip.Addr]struct{})
					}
					for _, address := range addresses {
						p.selfResolved[address.Unmap()] = struct{}{}
					}
					p.selfRetryAfter = time.Time{}
				} else if len(p.selfResolved) > 0 && ctx.Err() == nil {
					p.selfRetryAfter = time.Now().Add(10 * time.Second)
				}
				p.selfMu.Unlock()
			}
			p.selfMu.Lock()
			for address := range p.selfResolved {
				self[address] = struct{}{}
			}
			hasResolved := len(p.selfResolved) > 0
			p.selfMu.Unlock()
			if lookupErr != nil && !hasResolved {
				return nil, fmt.Errorf("%w: resolve proxy host: %v", errSelfUnavailable, lookupErr)
			}
		}
		knownPublic := false
		for address := range self {
			if publicAddress(address) {
				knownPublic = true
				break
			}
		}
		if !knownPublic {
			return nil, fmt.Errorf("%w: no public proxy address", errSelfUnavailable)
		}
	}
	addresses, err := p.localAddresses()
	if err != nil {
		return nil, fmt.Errorf("%w: inspect local addresses: %v", errSelfUnavailable, err)
	}
	for _, address := range addresses {
		self[address.Unmap()] = struct{}{}
	}
	return self, nil
}

func (p *proxyServer) destinations(ctx context.Context, authority, defaultPort string) ([]string, error) {
	host, port, err := splitTarget(authority, defaultPort)
	if err != nil {
		return nil, err
	}
	if p.selfHost != "" && strings.EqualFold(strings.TrimSuffix(host, "."), strings.TrimSuffix(p.selfHost, ".")) {
		return nil, errForbidden
	}
	self, err := p.selfAddresses(ctx)
	if err != nil {
		return nil, err
	}
	if literal, parseErr := netip.ParseAddr(host); parseErr == nil {
		if !publicAddress(literal) || isSelfAddress(self, literal) {
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
		if publicAddress(addr) && !isSelfAddress(self, addr) {
			targets = append(targets, net.JoinHostPort(addr.Unmap().String(), port))
		}
	}
	if len(targets) == 0 {
		return nil, errForbidden
	}
	return targets, nil
}

func isSelfAddress(self map[netip.Addr]struct{}, address netip.Addr) bool {
	_, found := self[address.Unmap()]
	return found
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
	upgrade := upstream.Header.Get("Upgrade")
	wantsUpgrade := upgrade != "" && headerHasToken(upstream.Header, "Connection", "Upgrade")
	removeHopHeaders(upstream.Header)
	if wantsUpgrade {
		upstream.Header.Set("Connection", "Upgrade")
		upstream.Header.Set("Upgrade", upgrade)
	}
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
	if response.StatusCode == http.StatusSwitchingProtocols {
		if !wantsUpgrade || !headerHasToken(response.Header, "Connection", "Upgrade") || response.Header.Get("Upgrade") == "" {
			http.Error(w, "invalid upstream protocol switch", http.StatusBadGateway)
			return
		}
		p.relayUpgrade(w, response)
		return
	}
	removeHopHeaders(response.Header)
	for name, values := range response.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
		_, err = io.Copy(flushingWriter{Writer: w, Flusher: flusher}, response.Body)
	} else {
		_, err = io.Copy(w, response.Body)
	}
	if err != nil {
		// Headers have already been sent. Abort instead of completing a truncated response.
		panic(http.ErrAbortHandler)
	}
}

type flushingWriter struct {
	io.Writer
	http.Flusher
}

func (w flushingWriter) Write(data []byte) (int, error) {
	n, err := w.Writer.Write(data)
	if n > 0 {
		w.Flusher.Flush()
	}
	return n, err
}

func (p *proxyServer) relayUpgrade(w http.ResponseWriter, response *http.Response) {
	upstream, ok := response.Body.(io.ReadWriteCloser)
	if !ok {
		http.Error(w, "upstream protocol switch unavailable", http.StatusBadGateway)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "tunneling unavailable", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	if _, err := fmt.Fprintf(client, "HTTP/1.1 %s\r\n", response.Status); err != nil {
		_ = client.Close()
		return
	}
	if err := response.Header.Write(client); err != nil {
		_ = client.Close()
		return
	}
	if _, err := io.WriteString(client, "\r\n"); err != nil {
		_ = client.Close()
		return
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, buffered); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, upstream); done <- struct{}{} }()
	<-done
	_ = client.Close()
	_ = upstream.Close()
	<-done
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, value := range h.Values(name) {
		for _, field := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(field), token) {
				return true
			}
		}
	}
	return false
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
	if errors.Is(err, errSelfUnavailable) {
		http.Error(w, "proxy address guard is unavailable", http.StatusBadGateway)
		return
	}
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
