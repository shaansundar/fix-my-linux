// Command fml-askpass is the SUDO_ASKPASS helper for Fix My Linux.
//
// sudo runs it (as the invoking user) when a command needs the administrator
// password. It forwards the request to the Fix My Linux app over a private
// Unix socket, the app shows its own password prompt naming the exact command,
// and the password the person types is written to stdout for sudo. Nothing is
// logged or stored.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

// Version 1 of the line-delimited JSON protocol.
type request struct {
	V      int    `json:"v"`
	PID    int    `json:"pid"`
	PPID   int    `json:"ppid"`
	Prompt string `json:"prompt"`
}

type response struct {
	OK       bool   `json:"ok"`
	Password string `json:"password,omitempty"`
}

// The person may take a while to come back to the computer and type it.
const waitForAnswer = 5 * time.Minute

func socketPath() (string, error) {
	if p := os.Getenv("FML_ASKPASS_SOCKET"); p != "" {
		return p, nil
	}
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		return filepath.Join(dir, "fix-my-linux", "askpass.sock"), nil
	}
	return "", errors.New("FML_ASKPASS_SOCKET is not set")
}

func ask(prompt string) (string, error) {
	path, err := socketPath()
	if err != nil {
		return "", err
	}
	conn, err := net.DialTimeout("unix", path, 5*time.Second)
	if err != nil {
		return "", fmt.Errorf("failed to reach Fix My Linux: %w", err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(waitForAnswer)); err != nil {
		return "", fmt.Errorf("failed to set deadline: %w", err)
	}

	req := request{V: 1, PID: os.Getpid(), PPID: os.Getppid(), Prompt: prompt}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return "", fmt.Errorf("failed to send request: %w", err)
	}

	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return "", fmt.Errorf("failed to read answer: %w", err)
	}
	var res response
	if err := json.Unmarshal(line, &res); err != nil {
		return "", fmt.Errorf("failed to parse answer: %w", err)
	}
	if !res.OK {
		return "", errors.New("the password prompt was cancelled")
	}
	return res.Password, nil
}

func main() {
	prompt := "Password:"
	if len(os.Args) > 1 {
		prompt = os.Args[1]
	}
	password, err := ask(prompt)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fml-askpass:", err)
		os.Exit(1)
	}
	fmt.Println(password)
}
