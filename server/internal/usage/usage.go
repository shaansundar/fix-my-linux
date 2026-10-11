// Package usage extracts token usage from Zen responses in each of the
// formats the AI SDK adapters speak, streamed (SSE) or not.
package usage

import (
	"bytes"
	"encoding/json"
	"strings"
)

// Usage is token counts for one model call. Input excludes cached tokens.
type Usage struct {
	Input      int64
	Output     int64
	CacheRead  int64
	CacheWrite int64
}

// Total is every token the request touched, used for context-size pricing tiers.
func (u Usage) PromptTotal() int64 { return u.Input + u.CacheRead + u.CacheWrite }

// Format is the wire format of an endpoint.
type Format int

const (
	FormatUnknown Format = iota
	// OpenAI chat completions; also Mistral and openai-compatible models.
	FormatChat
	// OpenAI Responses API.
	FormatResponses
	// Anthropic Messages API.
	FormatMessages
	// Google Gemini generateContent / streamGenerateContent.
	FormatGemini
)

// FormatFor picks the parser from the request path (after /zen/v1).
func FormatFor(path string) Format {
	switch {
	case strings.HasSuffix(path, "/chat/completions"):
		return FormatChat
	case strings.HasSuffix(path, "/responses"):
		return FormatResponses
	case strings.HasSuffix(path, "/messages"):
		return FormatMessages
	case strings.Contains(path, ":streamGenerateContent"), strings.Contains(path, ":generateContent"):
		return FormatGemini
	default:
		return FormatUnknown
	}
}

// Parser accumulates a response body chunk by chunk.
type Parser struct {
	format Format
	stream bool
	buf    bytes.Buffer
	usage  Usage
	found  bool
}

// NewParser returns a parser for a response; stream is true for text/event-stream bodies.
func NewParser(format Format, stream bool) *Parser {
	return &Parser{format: format, stream: stream}
}

// Write feeds response bytes; it never fails so it can sit in an io.MultiWriter.
func (p *Parser) Write(b []byte) (int, error) {
	p.buf.Write(b)
	if p.stream {
		p.drainLines()
	}
	// Bound memory for huge non-stream bodies; usage sits at the end, so keep the tail.
	if !p.stream && p.buf.Len() > 8<<20 {
		tail := append([]byte(nil), p.buf.Bytes()[p.buf.Len()-(1<<20):]...)
		p.buf.Reset()
		p.buf.Write(tail)
	}
	return len(b), nil
}

// Result returns the usage found so far, and whether any was found.
func (p *Parser) Result() (Usage, bool) {
	if p.stream {
		if rest := strings.TrimSpace(p.buf.String()); rest != "" {
			p.line(rest)
			p.buf.Reset()
		}
	} else if !p.found {
		p.object(p.buf.Bytes())
		if !p.found {
			// A huge body was trimmed to its tail; recover the trailing usage object.
			for _, key := range []string{`"usageMetadata"`, `"usage"`} {
				if obj, ok := trailingObject(p.buf.Bytes(), key); ok {
					p.object([]byte(`{` + key + `:` + string(obj) + `}`))
					if p.found {
						break
					}
				}
			}
		}
	}
	return p.usage, p.found
}

// trailingObject finds the last `key: {...}` in b and returns the balanced object.
func trailingObject(b []byte, key string) ([]byte, bool) {
	i := bytes.LastIndex(b, []byte(key))
	if i < 0 {
		return nil, false
	}
	rest := b[i+len(key):]
	start := bytes.IndexByte(rest, '{')
	if start < 0 {
		return nil, false
	}
	depth, inString, escaped := 0, false, false
	for j := start; j < len(rest); j++ {
		c := rest[j]
		switch {
		case escaped:
			escaped = false
		case c == '\\' && inString:
			escaped = true
		case c == '"':
			inString = !inString
		case inString:
		case c == '{':
			depth++
		case c == '}':
			depth--
			if depth == 0 {
				return rest[start : j+1], true
			}
		}
	}
	return nil, false
}

func (p *Parser) drainLines() {
	for {
		i := bytes.IndexByte(p.buf.Bytes(), '\n')
		if i < 0 {
			return
		}
		line := string(bytes.TrimRight(p.buf.Next(i+1), "\r\n"))
		p.line(line)
	}
}

func (p *Parser) line(line string) {
	data, ok := strings.CutPrefix(line, "data:")
	if !ok {
		return
	}
	data = strings.TrimSpace(data)
	if data == "" || data == "[DONE]" {
		return
	}
	p.object([]byte(data))
}

type chatUsage struct {
	PromptTokens        int64 `json:"prompt_tokens"`
	CompletionTokens    int64 `json:"completion_tokens"`
	PromptTokensDetails *struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	// Some openai-compatible providers report cache hits this way.
	PromptCacheHitTokens int64 `json:"prompt_cache_hit_tokens"`
}

type responsesUsage struct {
	InputTokens        int64 `json:"input_tokens"`
	OutputTokens       int64 `json:"output_tokens"`
	InputTokensDetails *struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"input_tokens_details"`
}

type anthropicUsage struct {
	InputTokens              *int64 `json:"input_tokens"`
	OutputTokens             *int64 `json:"output_tokens"`
	CacheReadInputTokens     *int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens *int64 `json:"cache_creation_input_tokens"`
}

type geminiUsage struct {
	PromptTokenCount        int64 `json:"promptTokenCount"`
	CandidatesTokenCount    int64 `json:"candidatesTokenCount"`
	CachedContentTokenCount int64 `json:"cachedContentTokenCount"`
	ThoughtsTokenCount      int64 `json:"thoughtsTokenCount"`
}

func (p *Parser) object(raw []byte) {
	switch p.format {
	case FormatChat:
		var v struct {
			Usage *chatUsage `json:"usage"`
		}
		if json.Unmarshal(raw, &v) != nil || v.Usage == nil {
			return
		}
		cached := v.Usage.PromptCacheHitTokens
		if v.Usage.PromptTokensDetails != nil {
			cached = v.Usage.PromptTokensDetails.CachedTokens
		}
		p.set(Usage{Input: max(v.Usage.PromptTokens-cached, 0), Output: v.Usage.CompletionTokens, CacheRead: cached})

	case FormatResponses:
		var v struct {
			Type     string `json:"type"`
			Usage    *responsesUsage
			Response *struct {
				Usage *responsesUsage `json:"usage"`
			} `json:"response"`
		}
		if json.Unmarshal(raw, &v) != nil {
			return
		}
		u := v.Usage
		if v.Response != nil && v.Response.Usage != nil {
			u = v.Response.Usage
		}
		if u == nil {
			return
		}
		var cached int64
		if u.InputTokensDetails != nil {
			cached = u.InputTokensDetails.CachedTokens
		}
		p.set(Usage{Input: max(u.InputTokens-cached, 0), Output: u.OutputTokens, CacheRead: cached})

	case FormatMessages:
		var v struct {
			Type    string          `json:"type"`
			Usage   *anthropicUsage `json:"usage"`
			Message *struct {
				Usage *anthropicUsage `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal(raw, &v) != nil {
			return
		}
		u := v.Usage
		if v.Message != nil && v.Message.Usage != nil {
			u = v.Message.Usage
		}
		if u == nil {
			return
		}
		// message_start carries input and cache counts; message_delta carries the
		// cumulative output count and sometimes updated input counts.
		next := p.usage
		if u.InputTokens != nil {
			next.Input = *u.InputTokens
		}
		if u.CacheReadInputTokens != nil {
			next.CacheRead = *u.CacheReadInputTokens
		}
		if u.CacheCreationInputTokens != nil {
			next.CacheWrite = *u.CacheCreationInputTokens
		}
		if u.OutputTokens != nil {
			next.Output = *u.OutputTokens
		}
		p.set(next)

	case FormatGemini:
		// Non-stream Gemini bodies may be a JSON array of chunks.
		if t := bytes.TrimSpace(raw); len(t) > 0 && t[0] == '[' {
			var chunks []json.RawMessage
			if json.Unmarshal(t, &chunks) == nil {
				for _, c := range chunks {
					p.object(c)
				}
			}
			return
		}
		var v struct {
			UsageMetadata *geminiUsage `json:"usageMetadata"`
		}
		if json.Unmarshal(raw, &v) != nil || v.UsageMetadata == nil {
			return
		}
		u := v.UsageMetadata
		p.set(Usage{
			Input:     max(u.PromptTokenCount-u.CachedContentTokenCount, 0),
			Output:    u.CandidatesTokenCount + u.ThoughtsTokenCount,
			CacheRead: u.CachedContentTokenCount,
		})
	}
}

func (p *Parser) set(u Usage) {
	p.usage = u
	p.found = true
}
