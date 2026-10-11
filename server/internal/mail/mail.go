// Package mail sends sign-in codes.
package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
)

// Resend sends through https://resend.com.
type Resend struct {
	APIKey  string
	From    string
	BaseURL string
	Client  *http.Client
}

func (r Resend) SendCode(ctx context.Context, to, code string) error {
	base := r.BaseURL
	if base == "" {
		base = "https://api.resend.com"
	}
	body, err := json.Marshal(map[string]any{
		"from":    r.From,
		"to":      []string{to},
		"subject": fmt.Sprintf("%s is your Fix My Linux code", code),
		"text":    codeText(code),
		"html":    codeHTML(code),
	})
	if err != nil {
		return fmt.Errorf("failed to encode email: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/emails", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to build email request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+r.APIKey)
	req.Header.Set("Content-Type", "application/json")
	client := r.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send email: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("failed to send email: status %d: %s", res.StatusCode, strings.TrimSpace(string(detail)))
	}
	return nil
}

// Log prints codes instead of sending them; for local development only.
type Log struct{ Logger *slog.Logger }

func (l Log) SendCode(_ context.Context, to, code string) error {
	l.Logger.Info("sign-in code (development mailer)", "to", to, "code", code)
	return nil
}

func codeText(code string) string {
	return "Your Fix My Linux sign-in code is " + code + ".\n\n" +
		"Type it into the app to continue. It expires in 10 minutes.\n" +
		"If you didn't ask for this, you can ignore this email.\n"
}

func codeHTML(code string) string {
	return `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#24272c">` +
		`<p>Your Fix My Linux sign-in code is</p>` +
		`<p style="font-size:28px;font-weight:600;letter-spacing:4px">` + code + `</p>` +
		`<p>Type it into the app to continue. It expires in 10 minutes.</p>` +
		`<p style="color:#7a7f87">If you didn't ask for this, you can ignore this email.</p></div>`
}
