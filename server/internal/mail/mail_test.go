package mail

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResend(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		wantErr bool
	}{
		{"sent", http.StatusOK, false},
		{"rejected", http.StatusUnprocessableEntity, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got map[string]any
			var auth string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				auth = r.Header.Get("Authorization")
				_ = json.NewDecoder(r.Body).Decode(&got)
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(`{"message":"nope"}`))
			}))
			defer srv.Close()
			err := Resend{APIKey: "re_123", From: "Fix My Linux <hello@fixmylinux.app>", BaseURL: srv.URL}.SendCode(context.Background(), "ana@example.com", "482913")
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v", err)
			}
			if auth != "Bearer re_123" {
				t.Errorf("auth = %q", auth)
			}
			if got["subject"] != "482913 is your Fix My Linux code" || !strings.Contains(got["text"].(string), "482913") {
				t.Errorf("email = %v", got)
			}
		})
	}
}
