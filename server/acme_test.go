package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestACMEHandlerOnlyServesChallengeTokens(t *testing.T) {
	root := t.TempDir()
	challengeDir := filepath.Join(root, ".well-known", "acme-challenge")
	if err := os.MkdirAll(challengeDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(challengeDir, "valid-token"), []byte("proof"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		path   string
		status int
	}{
		{"/.well-known/acme-challenge/valid-token", http.StatusOK},
		{"/.well-known/acme-challenge/missing", http.StatusNotFound},
		{"/credentials", http.StatusNotFound},
		{"/.well-known/acme-challenge/../valid-token", http.StatusNotFound},
	} {
		r := httptest.NewRequest(http.MethodGet, test.path, nil)
		w := httptest.NewRecorder()
		acmeHandler(root).ServeHTTP(w, r)
		if w.Code != test.status {
			t.Errorf("path %q: status %d, want %d", test.path, w.Code, test.status)
		}
	}
}
