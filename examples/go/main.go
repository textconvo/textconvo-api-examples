// TextConvo — Go example
//
// Authentication, optional HMAC signing, idempotency, error handling,
// rate-limit awareness, and retry with exponential backoff and jitter.
//
// Docs: https://textconvo.ai/docs
// Requires: Go 1.21+ (no third-party dependencies)
//
// Run:
//   export TEXTCONVO_API_KEY=... TEXTCONVO_SOURCE_KEY=...
//   go run main.go

package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/google/uuid" // or generate an id however you prefer
)

const ingestPath = "/functions/v1/ingest-lead"

// Lead mirrors the documented request body. Only Phone is required, in E.164
// format. Anything non-standard belongs in CustomFields, not at the top level.
type Lead struct {
	Phone        string                 `json:"phone"`
	Email        string                 `json:"email,omitempty"`
	ExternalID   string                 `json:"external_id,omitempty"`
	FirstName    string                 `json:"first_name,omitempty"`
	LastName     string                 `json:"last_name,omitempty"`
	City         string                 `json:"city,omitempty"`
	State        string                 `json:"state,omitempty"`
	Zip          string                 `json:"zip,omitempty"`
	LandingPage  string                 `json:"landing_page,omitempty"`
	Metadata     map[string]interface{} `json:"metadata,omitempty"`
	CustomFields map[string]interface{} `json:"custom_fields,omitempty"`
}

type ingestResponse struct {
	Success            bool   `json:"success"`
	IngestionRequestID string `json:"ingestion_request_id"`
	Duplicate          bool   `json:"duplicate"`
	Error              string `json:"error"`
	Code               string `json:"code"`
	RetryAfter         int    `json:"retry_after"`
}

// APIError carries everything you need to decide what to do next.
type APIError struct {
	Status     int
	Code       string
	Message    string
	RequestID  string
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	return fmt.Sprintf("textconvo: [%d %s] %s (request id %s)", e.Status, e.Code, e.Message, e.RequestID)
}

// Retryable reports whether another attempt could plausibly succeed.
func (e *APIError) Retryable() bool {
	return e.Status == http.StatusTooManyRequests || e.Status >= 500
}

type Client struct {
	BaseURL    string
	APIKey     string
	SourceKey  string
	HMACSecret string
	HTTPClient *http.Client
}

func NewClient() (*Client, error) {
	apiKey := os.Getenv("TEXTCONVO_API_KEY")
	sourceKey := os.Getenv("TEXTCONVO_SOURCE_KEY")
	if apiKey == "" || sourceKey == "" {
		return nil, errors.New("set TEXTCONVO_API_KEY and TEXTCONVO_SOURCE_KEY (see .env.example)")
	}

	baseURL := os.Getenv("TEXTCONVO_BASE_URL")
	if baseURL == "" {
		baseURL = "https://api.textconvo.ai"
	}

	return &Client{
		BaseURL:    baseURL,
		APIKey:     apiKey,
		SourceKey:  sourceKey,
		HMACSecret: os.Getenv("TEXTCONVO_HMAC_SECRET"),
		HTTPClient: &http.Client{Timeout: 10 * time.Second},
	}, nil
}

// IngestLead sends one lead. requestID is the idempotency key: reuse it across
// retries of the same logical lead and a timeout cannot create a duplicate.
func (c *Client) IngestLead(ctx context.Context, lead Lead, requestID string) (*ingestResponse, error) {
	// Marshal once: the exact bytes we sign are the exact bytes we send.
	rawBody, err := json.Marshal(lead)
	if err != nil {
		return nil, fmt.Errorf("marshal lead: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+ingestPath, bytes.NewReader(rawBody))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", c.APIKey)
	req.Header.Set("X-Source-Key", c.SourceKey)
	req.Header.Set("X-Request-Id", requestID)

	// Optional per-source signing: hex(HMAC_SHA256(secret, timestamp + "." + rawBody)).
	// The timestamp must be within 300 seconds of server time.
	if c.HMACSecret != "" {
		timestamp := strconv.FormatInt(time.Now().Unix(), 10)
		mac := hmac.New(sha256.New, []byte(c.HMACSecret))
		mac.Write([]byte(timestamp + "." + string(rawBody)))
		req.Header.Set("X-TC-Timestamp", timestamp)
		req.Header.Set("X-TC-Signature", hex.EncodeToString(mac.Sum(nil)))
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		// Connection-level failure: worth retrying.
		return nil, &APIError{Status: http.StatusServiceUnavailable, Code: "NETWORK_ERROR", Message: err.Error(), RequestID: requestID}
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	var parsed ingestResponse
	_ = json.Unmarshal(body, &parsed)

	if resp.StatusCode == http.StatusAccepted && parsed.Success {
		return &parsed, nil
	}

	apiErr := &APIError{Status: resp.StatusCode, Code: parsed.Code, Message: parsed.Error, RequestID: requestID}
	if apiErr.Code == "" {
		if resp.StatusCode == http.StatusTooManyRequests {
			apiErr.Code = "RATE_LIMITED"
		} else {
			apiErr.Code = "REQUEST_ERROR"
		}
	}
	if apiErr.Message == "" {
		apiErr.Message = fmt.Sprintf("unexpected status %d", resp.StatusCode)
	}
	if parsed.RetryAfter > 0 {
		apiErr.RetryAfter = time.Duration(parsed.RetryAfter) * time.Second
	}

	return nil, apiErr
}

// IngestLeadWithRetry retries 429, 5xx, and network failures only. A 400 or 401
// will fail identically forever, so we surface it immediately.
func (c *Client) IngestLeadWithRetry(ctx context.Context, lead Lead, maxAttempts int) (*ingestResponse, error) {
	requestID := uuid.NewString() // stable across attempts, on purpose
	var lastErr error

	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			wait := backoff(attempt, lastErr)
			fmt.Fprintf(os.Stderr, "retry %d in %s\n", attempt, wait)
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}

		resp, err := c.IngestLead(ctx, lead, requestID)
		if err == nil {
			return resp, nil
		}

		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.Retryable() {
			lastErr = err
			continue
		}
		return nil, err
	}

	return nil, lastErr
}

// backoff prefers the server hint, otherwise exponential with full jitter.
func backoff(attempt int, lastErr error) time.Duration {
	var apiErr *APIError
	if errors.As(lastErr, &apiErr) && apiErr.RetryAfter > 0 {
		return apiErr.RetryAfter
	}
	capped := math.Min(math.Pow(2, float64(attempt)), 30)
	return time.Duration(rand.Float64()*capped*float64(time.Second))
}

func main() {
	client, err := NewClient()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	phone := os.Getenv("TEST_PHONE")
	if phone == "" {
		phone = "+15035551234"
	}

	lead := Lead{
		Phone:     phone,
		FirstName: "Jane",
		LastName:  "Doe",
		Email:     "jane.doe@example.com",
		City:      "Portland",
		State:     "OR",
		Metadata:  map[string]interface{}{"campaign": "spring-promo"},
		CustomFields: map[string]interface{}{
			"roof_age_years": "12",
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	resp, err := client.IngestLeadWithRetry(ctx, lead, 4)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		fmt.Fprintln(os.Stderr, "Error codes: https://textconvo.ai/docs#error-codes")
		os.Exit(1)
	}

	fmt.Printf("accepted: %s\n", resp.IngestionRequestID)
	if resp.Duplicate {
		fmt.Println("duplicate: already ingested under this request id — idempotency did its job")
	}
	fmt.Println("progress arrives by webhook: https://textconvo.ai/docs#webhooks")
}
