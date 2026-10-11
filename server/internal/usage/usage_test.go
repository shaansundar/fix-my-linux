package usage

import (
	"strings"
	"testing"
)

func sse(events ...string) string {
	var b strings.Builder
	for _, e := range events {
		b.WriteString("data: " + e + "\n\n")
	}
	return b.String()
}

func TestParser(t *testing.T) {
	tests := []struct {
		name   string
		format Format
		stream bool
		body   string
		want   Usage
		found  bool
	}{
		{
			name: "chat stream with include_usage", format: FormatChat, stream: true,
			body: sse(`{"choices":[{"delta":{"content":"hi"}}]}`,
				`{"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":80,"prompt_tokens_details":{"cached_tokens":1000}}}`) + "data: [DONE]\n\n",
			want: Usage{Input: 200, Output: 80, CacheRead: 1000}, found: true,
		},
		{
			name: "chat stream with deepseek-style cache hits", format: FormatChat, stream: true,
			body: sse(`{"choices":[],"usage":{"prompt_tokens":500,"completion_tokens":10,"prompt_cache_hit_tokens":300}}`),
			want: Usage{Input: 200, Output: 10, CacheRead: 300}, found: true,
		},
		{
			name: "chat json", format: FormatChat,
			body: `{"choices":[{"message":{"content":"x"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`,
			want: Usage{Input: 10, Output: 5}, found: true,
		},
		{
			name: "responses stream", format: FormatResponses, stream: true,
			body: "event: response.created\n" + sse(`{"type":"response.created","response":{}}`) +
				"event: response.completed\n" + sse(`{"type":"response.completed","response":{"usage":{"input_tokens":3000,"input_tokens_details":{"cached_tokens":2048},"output_tokens":150}}}`),
			want: Usage{Input: 952, Output: 150, CacheRead: 2048}, found: true,
		},
		{
			name: "responses json", format: FormatResponses,
			body: `{"id":"resp_1","usage":{"input_tokens":40,"output_tokens":7}}`,
			want: Usage{Input: 40, Output: 7}, found: true,
		},
		{
			name: "anthropic stream", format: FormatMessages, stream: true,
			body: "event: message_start\n" + sse(`{"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":4000,"cache_creation_input_tokens":300,"output_tokens":1}}}`) +
				"event: content_block_delta\n" + sse(`{"type":"content_block_delta","delta":{"text":"Hello"}}`) +
				"event: message_delta\n" + sse(`{"type":"message_delta","usage":{"output_tokens":420}}`),
			want: Usage{Input: 25, Output: 420, CacheRead: 4000, CacheWrite: 300}, found: true,
		},
		{
			name: "anthropic json", format: FormatMessages,
			body: `{"type":"message","usage":{"input_tokens":12,"output_tokens":34,"cache_read_input_tokens":0}}`,
			want: Usage{Input: 12, Output: 34}, found: true,
		},
		{
			name: "gemini stream: the last usageMetadata wins", format: FormatGemini, stream: true,
			body: sse(`{"candidates":[],"usageMetadata":{"promptTokenCount":900,"candidatesTokenCount":5}}`,
				`{"candidates":[],"usageMetadata":{"promptTokenCount":900,"candidatesTokenCount":60,"cachedContentTokenCount":400,"thoughtsTokenCount":40}}`),
			want: Usage{Input: 500, Output: 100, CacheRead: 400}, found: true,
		},
		{
			name: "gemini json array", format: FormatGemini,
			body: `[{"candidates":[]},{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}]`,
			want: Usage{Input: 10, Output: 2}, found: true,
		},
		{
			name: "no usage reported", format: FormatChat, stream: true,
			body: sse(`{"choices":[{"delta":{"content":"hi"}}]}`), found: false,
		},
		{
			name: "garbage is ignored", format: FormatMessages, stream: true,
			body: "data: {not json\n\n: comment\n\n", found: false,
		},
		{
			name: "final event without trailing newline", format: FormatChat, stream: true,
			body: `data: {"usage":{"prompt_tokens":3,"completion_tokens":4}}`,
			want: Usage{Input: 3, Output: 4}, found: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := NewParser(tt.format, tt.stream)
			// Feed in awkward chunk sizes to exercise line buffering.
			for i := 0; i < len(tt.body); i += 7 {
				end := min(i+7, len(tt.body))
				_, _ = p.Write([]byte(tt.body[i:end]))
			}
			got, found := p.Result()
			if found != tt.found {
				t.Fatalf("found = %v, want %v", found, tt.found)
			}
			if got != tt.want {
				t.Errorf("usage = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestFormatFor(t *testing.T) {
	tests := map[string]Format{
		"/chat/completions": FormatChat,
		"/responses":        FormatResponses,
		"/messages":         FormatMessages,
		"/models/gemini-3-flash:streamGenerateContent": FormatGemini,
		"/models/gemini-3-flash:generateContent":       FormatGemini,
		"/models":                                      FormatUnknown,
	}
	for path, want := range tests {
		if got := FormatFor(path); got != want {
			t.Errorf("FormatFor(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestLargeJSONBodyKeepsTail(t *testing.T) {
	p := NewParser(FormatChat, false)
	_, _ = p.Write([]byte(`{"choices":[{"message":{"content":"`))
	_, _ = p.Write([]byte(strings.Repeat("x", 9<<20)))
	_, _ = p.Write([]byte(`"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}`))
	got, found := p.Result()
	if !found || got != (Usage{Input: 1, Output: 2}) {
		t.Fatalf("usage from trimmed body = %+v, %v", got, found)
	}
}
