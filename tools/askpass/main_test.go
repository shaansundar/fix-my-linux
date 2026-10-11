package main

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func serve(t *testing.T, answer response) (string, <-chan request) {
	t.Helper()
	// Unix socket paths are limited to ~104 bytes on macOS; t.TempDir() is too deep.
	dir, err := os.MkdirTemp("", "ap")
	if err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "s")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	got := make(chan request, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, _ := bufio.NewReader(conn).ReadBytes('\n')
		var req request
		_ = json.Unmarshal(line, &req)
		got <- req
		_ = json.NewEncoder(conn).Encode(answer)
	}()
	return path, got
}

func TestAsk(t *testing.T) {
	tests := []struct {
		name    string
		answer  response
		want    string
		wantErr bool
	}{
		{name: "returns the typed password", answer: response{OK: true, Password: "hunter2"}, want: "hunter2"},
		{name: "keeps spaces and symbols", answer: response{OK: true, Password: " p@ss word "}, want: " p@ss word "},
		{name: "cancelled prompt is an error", answer: response{OK: false}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path, got := serve(t, tt.answer)
			t.Setenv("FML_ASKPASS_SOCKET", path)

			pw, err := ask("[sudo] password for ana: ")
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if pw != tt.want {
				t.Errorf("password = %q, want %q", pw, tt.want)
			}
			req := <-got
			if req.V != 1 || req.PID != os.Getpid() || req.PPID != os.Getppid() || req.Prompt != "[sudo] password for ana: " {
				t.Errorf("unexpected request %+v", req)
			}
		})
	}
}

func TestAskWithoutApp(t *testing.T) {
	t.Setenv("FML_ASKPASS_SOCKET", filepath.Join(t.TempDir(), "missing.sock"))
	if _, err := ask("x"); err == nil {
		t.Fatal("expected an error when the app is not listening")
	}
}

func TestSocketPathFallback(t *testing.T) {
	t.Setenv("FML_ASKPASS_SOCKET", "")
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1000")
	p, err := socketPath()
	if err != nil || p != "/run/user/1000/fix-my-linux/askpass.sock" {
		t.Fatalf("socketPath() = %q, %v", p, err)
	}
	t.Setenv("XDG_RUNTIME_DIR", "")
	if _, err := socketPath(); err == nil {
		t.Fatal("expected an error with no socket configured")
	}
}
