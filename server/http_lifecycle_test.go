package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func boundedTestServer(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.Config = newHTTPServer(server.Listener.Addr().String(), handler)
	// Exercise the production configuration, with a shorter wait. An absent
	// production timeout remains zero and fails the connection-closure tests.
	server.Config.ReadTimeout /= 60
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func tlsTestClient(t *testing.T, server *httptest.Server) net.Conn {
	t.Helper()
	config := server.Client().Transport.(*http.Transport).TLSClientConfig
	client, err := tls.Dial("tcp", server.Listener.Addr().String(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	if err := client.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	return client
}

func TestUnauthenticatedBodiesReleaseConnections(t *testing.T) {
	wrong := base64.StdEncoding.EncodeToString([]byte("browser:wrong"))
	for _, test := range []struct {
		name, method, headers, body, status string
	}{
		{"missing auth", "POST", "Content-Length: 1\r\n", "", "407"},
		{"wrong auth on GET", "GET", "Content-Length: 1\r\nProxy-Authorization: Basic " + wrong + "\r\n", "", "407"},
		{"chunked body", "POST", "Transfer-Encoding: chunked\r\n", "1\r\n", "407"},
		{"incomplete trailers", "POST", "Transfer-Encoding: chunked\r\nTrailer: X-End\r\n", "0\r\nX-End:", "407"},
		{"continue", "POST", "Content-Length: 1\r\nExpect: 100-continue\r\n", "", "407"},
		{"close requested", "POST", "Content-Length: 1\r\nConnection: close\r\n", "", "407"},
		{"framework rejection", "POST", "Content-Length: 1\r\nExpect: unsupported\r\n", "", "417"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := boundedTestServer(t, testProxy(t, "browser", "secret"))
			client := tlsTestClient(t, server)
			_, err := fmt.Fprintf(client, "%s http://example.org/ HTTP/1.1\r\nHost: example.org\r\n%s\r\n%s", test.method, test.headers, test.body)
			if err != nil {
				t.Fatal(err)
			}
			// A status alone is insufficient: cleanup must also release the socket.
			response, err := io.ReadAll(client)
			if err != nil {
				t.Fatalf("incomplete unauthenticated body retained the connection: %v", err)
			}
			if !strings.HasPrefix(string(response), "HTTP/1.1 "+test.status+" ") {
				t.Fatalf("unexpected response: %q", response)
			}
		})
	}
}

func TestACMEBodiesReleaseConnections(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, ".well-known", "acme-challenge")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "token"), []byte("proof"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "HEAD", "POST"} {
		t.Run(method, func(t *testing.T) {
			server := boundedTestServer(t, acmeHandler(root))
			client := tlsTestClient(t, server)
			_, err := fmt.Fprintf(client, "%s /.well-known/acme-challenge/token HTTP/1.1\r\nHost: proxy.test\r\nContent-Length: 1\r\n\r\n", method)
			if err != nil {
				t.Fatal(err)
			}
			response, err := io.ReadAll(client)
			if err != nil {
				t.Fatalf("incomplete ACME body retained the connection: %v", err)
			}
			status := "200"
			if method == "POST" {
				status = "404"
			}
			if !strings.HasPrefix(string(response), "HTTP/1.1 "+status+" ") {
				t.Fatalf("unexpected response: %q", response)
			}
			if method == "GET" && !strings.Contains(string(response), "proof") {
				t.Fatalf("missing challenge proof: %q", response)
			}
		})
	}
}

func TestAuthenticatedSlowUploadOutlivesReadTimeout(t *testing.T) {
	for _, chunked := range []bool{false, true} {
		t.Run(fmt.Sprintf("chunked=%t", chunked), func(t *testing.T) {
			p := testProxy(t, "browser", "secret")
			p.lookup = func(context.Context, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
			}
			proxySide, origin := net.Pipe()
			defer origin.Close()
			p.dial = func(context.Context, string) (net.Conn, error) { return proxySide, nil }
			received := make(chan string, 1)
			go func() {
				defer origin.Close()
				r, err := http.ReadRequest(bufio.NewReader(origin))
				if err != nil {
					received <- err.Error()
					return
				}
				body, err := io.ReadAll(r.Body)
				_ = r.Body.Close()
				if err != nil {
					received <- err.Error()
					return
				}
				received <- string(body)
				_, _ = io.WriteString(origin, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
			}()
			server := boundedTestServer(t, p)
			client := tlsTestClient(t, server)
			header, body := "Content-Length: 4", "ping"
			if chunked {
				header, body = "Transfer-Encoding: chunked", "4\r\nping\r\n0\r\n\r\n"
			}
			auth := base64.StdEncoding.EncodeToString([]byte("browser:secret"))
			_, err := fmt.Fprintf(client, "POST http://example.org/upload HTTP/1.1\r\nHost: example.org\r\nProxy-Authorization: Basic %s\r\n%s\r\n\r\n", auth, header)
			if err != nil {
				t.Fatal(err)
			}
			time.Sleep(server.Config.ReadTimeout + 100*time.Millisecond)
			if _, err := io.WriteString(client, body); err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(client), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			data, err := io.ReadAll(response.Body)
			if response.StatusCode != 200 || err != nil || string(data) != "ok" {
				t.Fatalf("slow authenticated upload failed: status=%d body=%q err=%v", response.StatusCode, data, err)
			}
			if body := <-received; body != "ping" {
				t.Fatalf("upstream received %q", body)
			}
		})
	}
}

func TestAuthenticationRetryOnSameConnection(t *testing.T) {
	server := boundedTestServer(t, testProxy(t, "browser", "secret"))
	client := tlsTestClient(t, server)
	reader := bufio.NewReader(client)
	auth := base64.StdEncoding.EncodeToString([]byte("browser:secret"))
	for _, attempt := range []struct {
		header string
		status int
	}{{"", 407}, {"Proxy-Authorization: Basic " + auth + "\r\n", 403}} {
		_, err := fmt.Fprintf(client, "GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\n%s\r\n", attempt.header)
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.ReadResponse(reader, nil)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != attempt.status {
			t.Fatalf("status=%d, want %d", response.StatusCode, attempt.status)
		}
	}
}

func TestHTTPForwardingReportsTruncatedResponses(t *testing.T) {
	for _, test := range []struct {
		name, wire string
		complete   bool
	}{
		{"complete chunked", "Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n", true},
		{"missing final chunk", "Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n", false},
		{"short content length", "Content-Length: 10\r\n\r\nhello", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			p := testProxy(t, "browser", "secret")
			p.lookup = func(context.Context, string) ([]netip.Addr, error) {
				return []netip.Addr{netip.MustParseAddr("1.1.1.1")}, nil
			}
			proxySide, origin := net.Pipe()
			defer origin.Close()
			p.dial = func(context.Context, string) (net.Conn, error) { return proxySide, nil }
			go func() {
				defer origin.Close()
				r, err := http.ReadRequest(bufio.NewReader(origin))
				if err != nil {
					return
				}
				_ = r.Body.Close()
				_, _ = io.WriteString(origin, "HTTP/1.1 200 OK\r\n"+test.wire)
			}()
			server := boundedTestServer(t, p)
			client := tlsTestClient(t, server)
			auth := base64.StdEncoding.EncodeToString([]byte("browser:secret"))
			_, err := fmt.Fprintf(client, "GET http://example.org/download HTTP/1.1\r\nHost: example.org\r\nProxy-Authorization: Basic %s\r\n\r\n", auth)
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(client), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if response.StatusCode != 200 || string(body) != "hello" || (err == nil) != test.complete {
				t.Fatalf("response status=%d body=%q err=%v; complete=%t", response.StatusCode, body, err, test.complete)
			}
		})
	}
}
