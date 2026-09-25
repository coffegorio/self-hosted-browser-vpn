package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func testProxy(t *testing.T, user, password string) *proxyServer {
	t.Helper()
	p, err := newProxy(user, password)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestProxyAuthenticationUsesEphemeralKey(t *testing.T) {
	first := testProxy(t, "browser", "secret")
	second := testProxy(t, "browser", "secret")
	if first.authKey == second.authKey || first.authTag == second.authTag {
		t.Fatal("separate proxy instances must not use the same authentication verifier")
	}
	correct := "Basic " + base64.StdEncoding.EncodeToString([]byte("browser:secret"))
	wrong := "Basic " + base64.StdEncoding.EncodeToString([]byte("browser:secreu"))
	for _, proxy := range []*proxyServer{first, second} {
		if !proxy.authorized(correct) || proxy.authorized(wrong) {
			t.Fatal("proxy accepted an incorrect credential or rejected the correct one")
		}
	}
}

func TestProxyRequiresAuthenticationAndBlocksPrivateTarget(t *testing.T) {
	p := testProxy(t, "browser", "secret")
	for _, test := range []struct {
		name   string
		auth   string
		status int
	}{
		{"missing", "", http.StatusProxyAuthRequired},
		{"wrong", "Basic " + base64.StdEncoding.EncodeToString([]byte("browser:wrong")), http.StatusProxyAuthRequired},
		{"correct", "Basic " + base64.StdEncoding.EncodeToString([]byte("browser:secret")), http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "http://169.254.169.254/latest/meta-data/", nil)
			if test.auth != "" {
				r.Header.Set("Proxy-Authorization", test.auth)
			}
			w := httptest.NewRecorder()
			p.ServeHTTP(w, r)
			if w.Code != test.status {
				t.Fatalf("status = %d, want %d", w.Code, test.status)
			}
			if test.status == http.StatusProxyAuthRequired && w.Header().Get("Proxy-Authenticate") == "" {
				t.Fatal("407 response has no proxy authentication challenge")
			}
		})
	}
}

func TestConnectRelaysBytesBufferedAfterHeaders(t *testing.T) {
	p := testProxy(t, "browser", "secret")
	p.lookup = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("2606:4700:4700::1111"), netip.MustParseAddr("1.1.1.1")}, nil
	}
	proxySide, remoteSide := net.Pipe()
	defer remoteSide.Close()
	var dialed []string
	p.dial = func(_ context.Context, target string) (net.Conn, error) {
		dialed = append(dialed, target)
		if target == "[2606:4700:4700::1111]:443" {
			return nil, errors.New("IPv6 route unavailable")
		}
		if target != "1.1.1.1:443" {
			t.Errorf("unexpected dial target %q", target)
		}
		return proxySide, nil
	}
	server := httptest.NewServer(p)
	defer server.Close()
	client, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(5 * time.Second))
	_ = remoteSide.SetDeadline(time.Now().Add(5 * time.Second))
	remoteResult := make(chan string, 1)
	go func() {
		data := make([]byte, 4)
		_, err := io.ReadFull(remoteSide, data)
		if err != nil {
			remoteResult <- err.Error()
			return
		}
		remoteResult <- string(data)
		_, _ = remoteSide.Write([]byte("PONG"))
	}()
	auth := base64.StdEncoding.EncodeToString([]byte("browser:secret"))
	if _, err := fmt.Fprintf(client, "CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\nProxy-Authorization: Basic %s\r\n\r\nPING", auth); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(client)
	first, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(first, " 200 ") {
		t.Fatalf("CONNECT status = %q, %v", first, err)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	if result := <-remoteResult; result != "PING" {
		t.Fatalf("upstream received %q, want PING", result)
	}
	response := make([]byte, 4)
	if _, err := io.ReadFull(reader, response); err != nil || string(response) != "PONG" {
		t.Fatalf("downstream received %q, %v", response, err)
	}
	if got := strings.Join(dialed, ","); got != "[2606:4700:4700::1111]:443,1.1.1.1:443" {
		t.Fatalf("dial attempts = %q", got)
	}
}

func TestHTTPForwardingPinsAddressAndStripsProxyCredentials(t *testing.T) {
	p := testProxy(t, "browser", "secret")
	p.lookup = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("2606:4700:4700::1111"), netip.MustParseAddr("1.1.1.1")}, nil
	}
	proxySide, remoteSide := net.Pipe()
	defer remoteSide.Close()
	var dialed []string
	p.dial = func(_ context.Context, target string) (net.Conn, error) {
		dialed = append(dialed, target)
		if target == "[2606:4700:4700::1111]:80" {
			return nil, errors.New("IPv6 route unavailable")
		}
		if target != "1.1.1.1:80" {
			t.Errorf("unexpected dial target %q", target)
		}
		return proxySide, nil
	}
	upstreamResult := make(chan string, 1)
	go func() {
		defer remoteSide.Close()
		req, err := http.ReadRequest(bufio.NewReader(remoteSide))
		if err != nil {
			upstreamResult <- err.Error()
			return
		}
		defer req.Body.Close()
		if req.Host != "example.org" || req.Header.Get("Proxy-Authorization") != "" || req.URL.Path != "/path" {
			upstreamResult <- fmt.Sprintf("unexpected request: host=%q proxy-auth=%q path=%q", req.Host, req.Header.Get("Proxy-Authorization"), req.URL.Path)
		} else {
			upstreamResult <- "ok"
		}
		_, _ = io.WriteString(remoteSide, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
	}()
	r := httptest.NewRequest(http.MethodGet, "http://example.org/path", nil)
	r.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte("browser:secret")))
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	if result := <-upstreamResult; result != "ok" {
		t.Fatal(result)
	}
	if w.Code != http.StatusOK || w.Body.String() != "ok" {
		t.Fatalf("status %d, body %q", w.Code, w.Body.String())
	}
	if got := strings.Join(dialed, ","); got != "[2606:4700:4700::1111]:80,1.1.1.1:80" {
		t.Fatalf("dial attempts = %q", got)
	}
}

func TestPublicAddressPolicy(t *testing.T) {
	for _, test := range []struct {
		address string
		want    bool
	}{
		{"127.0.0.1", false},
		{"10.0.0.1", false},
		{"100.64.0.1", false},
		{"169.254.169.254", false},
		{"192.168.1.1", false},
		{"198.18.0.1", false},
		{"192.0.2.1", false},
		{"::1", false},
		{"fd00::1", false},
		{"fe80::1", false},
		{"::ffff:127.0.0.1", false},
		{"2001:db8::1", false},
		{"2002:c0a8:0101::", false},
		{"1.1.1.1", true},
		{"2606:4700:4700::1111", true},
	} {
		t.Run(test.address, func(t *testing.T) {
			got := publicAddress(netip.MustParseAddr(test.address))
			if got != test.want {
				t.Fatalf("publicAddress(%s) = %t, want %t", test.address, got, test.want)
			}
		})
	}
}

func TestDestinationPinsVettedDNSAddress(t *testing.T) {
	p := testProxy(t, "browser", "secret")
	p.lookup = func(_ context.Context, host string) ([]netip.Addr, error) {
		if host != "example.org" {
			t.Fatalf("unexpected host %q", host)
		}
		return []netip.Addr{
			netip.MustParseAddr("127.0.0.1"),
			netip.MustParseAddr("1.1.1.1"),
		}, nil
	}
	targets, err := p.destinations(context.Background(), "example.org:443", "")
	if err != nil || len(targets) != 1 || targets[0] != "1.1.1.1:443" {
		t.Fatalf("destinations = %q, %v; want only the public address", targets, err)
	}
}

func TestSelfAddressGuard(t *testing.T) {
	p := testProxy(t, "browser", "secret")
	p.selfHost = "proxy.example.org"
	p.extraSelf = []netip.Addr{netip.MustParseAddr("9.9.9.9")}
	p.localAddresses = func() ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("2606:4700:4700::1111")}, nil
	}
	p.lookup = func(_ context.Context, host string) ([]netip.Addr, error) {
		switch host {
		case "proxy.example.org":
			return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
		case "alias.example.org":
			return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
		case "mixed.example.org":
			return []netip.Addr{netip.MustParseAddr("1.1.1.1"), netip.MustParseAddr("8.8.8.8")}, nil
		default:
			t.Fatalf("unexpected lookup for %q", host)
			return nil, nil
		}
	}
	for _, authority := range []string{
		"1.1.1.1:443", "[::ffff:1.1.1.1]:443", "[2606:4700:4700::1111]:443",
		"9.9.9.9:443", "alias.example.org:443",
	} {
		t.Run(authority, func(t *testing.T) {
			if _, err := p.destinations(context.Background(), authority, ""); !errors.Is(err, errForbidden) {
				t.Fatalf("self destination %q should be blocked, got %v", authority, err)
			}
		})
	}
	targets, err := p.destinations(context.Background(), "mixed.example.org:443", "")
	if err != nil || len(targets) != 1 || targets[0] != "8.8.8.8:443" {
		t.Fatalf("mixed destinations = %v, %v; want only unrelated public IP", targets, err)
	}
	targets, err = p.destinations(context.Background(), "8.8.8.8:443", "")
	if err != nil || len(targets) != 1 || targets[0] != "8.8.8.8:443" {
		t.Fatalf("unrelated public destination = %v, %v", targets, err)
	}

	dialed := false
	p.dial = func(context.Context, string) (net.Conn, error) {
		dialed = true
		return nil, errors.New("unexpected dial")
	}
	auth := "Basic " + base64.StdEncoding.EncodeToString([]byte("browser:secret"))
	connectRequest := httptest.NewRequest(http.MethodConnect, "http://example.org", nil)
	connectRequest.Host = "1.1.1.1:443"
	for _, request := range []*http.Request{
		connectRequest,
		httptest.NewRequest(http.MethodGet, "http://alias.example.org/path", nil),
	} {
		request.Header.Set("Proxy-Authorization", auth)
		response := httptest.NewRecorder()
		p.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || dialed {
			t.Fatalf("self request returned HTTP %d or dialed=%t", response.Code, dialed)
		}
	}
}

func TestSelfAddressLookupFailsClosed(t *testing.T) {
	p := testProxy(t, "browser", "secret")
	p.selfHost = "proxy.example.org"
	p.localAddresses = func() ([]netip.Addr, error) { return nil, nil }
	p.lookup = func(context.Context, string) ([]netip.Addr, error) {
		return nil, errors.New("DNS unavailable")
	}
	if _, err := p.destinations(context.Background(), "8.8.8.8:443", ""); !errors.Is(err, errSelfUnavailable) {
		t.Fatalf("proxy host lookup failure should fail closed, got %v", err)
	}
}

func TestSelfAddressGuardRetainsResolvedAddresses(t *testing.T) {
	p := testProxy(t, "browser", "secret")
	p.selfHost = "proxy.example.org"
	p.localAddresses = func() ([]netip.Addr, error) { return nil, nil }
	phase := 0
	lookups := 0
	p.lookup = func(_ context.Context, host string) ([]netip.Addr, error) {
		lookups++
		if host != p.selfHost {
			t.Fatalf("unexpected lookup for %q", host)
		}
		switch phase {
		case 0:
			return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
		case 1:
			return []netip.Addr{netip.MustParseAddr("9.9.9.9")}, nil
		default:
			return nil, errors.New("DNS temporarily unavailable")
		}
	}
	if _, err := p.selfAddresses(context.Background()); err != nil {
		t.Fatal(err)
	}
	phase = 1
	for _, address := range []string{"1.1.1.1:443", "9.9.9.9:443"} {
		if _, err := p.destinations(context.Background(), address, ""); !errors.Is(err, errForbidden) {
			t.Fatalf("self address %s after DNS change: %v", address, err)
		}
	}
	phase = 2
	if _, err := p.destinations(context.Background(), "1.1.1.1:443", ""); !errors.Is(err, errForbidden) {
		t.Fatalf("historical self address during DNS outage: %v", err)
	}
	previousLookups := lookups
	targets, err := p.destinations(context.Background(), "8.8.8.8:443", "")
	if err != nil || len(targets) != 1 || targets[0] != "8.8.8.8:443" {
		t.Fatalf("public address during DNS outage = %v, %v", targets, err)
	}
	if lookups != previousLookups {
		t.Fatalf("repeated destination lookup retried unavailable proxy DNS")
	}
}

func TestBlockedPort(t *testing.T) {
	p := testProxy(t, "browser", "secret")
	_, err := p.destinations(context.Background(), "1.1.1.1:22", "")
	if err == nil || !strings.Contains(err.Error(), "blocked") {
		t.Fatalf("port 22 should be blocked, got %v", err)
	}
}

func TestHTTPForwardingFlushesStreamingResponse(t *testing.T) {
	p := testProxy(t, "browser", "secret")
	p.lookup = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
	}
	proxySide, origin := net.Pipe()
	defer origin.Close()
	p.dial = func(context.Context, string) (net.Conn, error) { return proxySide, nil }
	server := httptest.NewServer(p)
	defer server.Close()
	started := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	go func() {
		request, err := http.ReadRequest(bufio.NewReader(origin))
		if err != nil {
			return
		}
		_ = request.Body.Close()
		_, _ = io.WriteString(origin, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
		close(started)
		<-release
	}()
	client, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	auth := base64.StdEncoding.EncodeToString([]byte("browser:secret"))
	if _, err := fmt.Fprintf(client, "GET http://example.org/events HTTP/1.1\r\nHost: example.org\r\nProxy-Authorization: Basic %s\r\n\r\n", auth); err != nil {
		t.Fatal(err)
	}
	<-started
	reader := bufio.NewReader(client)
	first, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(first, " 200 ") {
		t.Fatalf("streaming response status = %q, %v", first, err)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	chunk, err := reader.ReadString('\n')
	if err != nil || chunk != "5\r\n" {
		t.Fatalf("first stream chunk = %q, %v", chunk, err)
	}
	data := make([]byte, 5)
	if _, err := io.ReadFull(reader, data); err != nil || string(data) != "hello" {
		t.Fatalf("first stream event = %q, %v", data, err)
	}
}

func TestHTTPUpgradeRelaysBothDirections(t *testing.T) {
	p := testProxy(t, "browser", "secret")
	p.lookup = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
	}
	proxySide, origin := net.Pipe()
	defer origin.Close()
	p.dial = func(context.Context, string) (net.Conn, error) { return proxySide, nil }
	server := httptest.NewServer(p)
	defer server.Close()
	originResult := make(chan string, 1)
	go func() {
		reader := bufio.NewReader(origin)
		request, err := http.ReadRequest(reader)
		if err != nil {
			originResult <- err.Error()
			return
		}
		_ = request.Body.Close()
		if request.Header.Get("Connection") != "Upgrade" || request.Header.Get("Upgrade") != "websocket" || request.Header.Get("Proxy-Authorization") != "" {
			originResult <- fmt.Sprintf("unexpected headers: %v", request.Header)
			return
		}
		_, _ = io.WriteString(origin, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		data := make([]byte, 4)
		_, err = io.ReadFull(reader, data)
		if err != nil {
			originResult <- err.Error()
			return
		}
		originResult <- string(data)
		_, _ = io.WriteString(origin, "PONG")
	}()
	client, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	auth := base64.StdEncoding.EncodeToString([]byte("browser:secret"))
	if _, err := fmt.Fprintf(client, "GET http://example.org/socket HTTP/1.1\r\nHost: example.org\r\nProxy-Authorization: Basic %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n", auth); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(client)
	first, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(first, " 101 ") {
		t.Fatalf("upgrade response status = %q, %v", first, err)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	if _, err := io.WriteString(client, "PING"); err != nil {
		t.Fatal(err)
	}
	if got := <-originResult; got != "PING" {
		t.Fatalf("upstream received %q, want PING", got)
	}
	data := make([]byte, 4)
	if _, err := io.ReadFull(reader, data); err != nil || string(data) != "PONG" {
		t.Fatalf("downstream received %q, %v", data, err)
	}
}
