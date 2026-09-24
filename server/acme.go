package main

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var acmeToken = regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`)

func acmeHandler(webroot string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "/.well-known/acme-challenge/"
		if (r.Method != http.MethodGet && r.Method != http.MethodHead) || !strings.HasPrefix(r.URL.Path, prefix) {
			http.NotFound(w, r)
			return
		}
		token := strings.TrimPrefix(r.URL.Path, prefix)
		if !acmeToken.MatchString(token) {
			http.NotFound(w, r)
			return
		}
		name := filepath.Join(webroot, ".well-known", "acme-challenge", token)
		data, err := os.ReadFile(name)
		if err != nil || len(data) > 8<<10 {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
	})
}
