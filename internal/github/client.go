package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type authKind int

const (
	authNone         authKind = iota
	authApp                   // JWT of the app: endpoints under /app
	authInstallation          // installation token: everything about runners, jobs, repositories
)

// call is one request to the REST API.
type call struct {
	method  string
	path    string // starts with /, may carry a query
	body    any
	auth    authKind
	account int64 // the app; 0 for authNone
	// conditional sends the ETag of the last answer and serves the cached
	// body on 304, which GitHub does not count against the rate limit.
	conditional bool
	// once sends the request a single time: for requests that must not
	// happen twice, like starting a workflow.
	once bool
}

type response struct {
	status int
	header http.Header
	body   []byte
	cached bool // answered from the conditional cache (304)
}

type condEntry struct {
	etag string
	body []byte
}

// apiError is an answer of GitHub outside 2xx.
type apiError struct {
	Status  int
	Method  string
	Path    string
	Message string
}

func (e *apiError) Error() string {
	path := e.Path
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	msg := fmt.Sprintf("GitHub answered %d to %s %s", e.Status, e.Method, path)
	if e.Message != "" {
		msg += ": " + e.Message
	}
	switch e.Status {
	case http.StatusUnauthorized:
		msg += ". The app's key may have been revoked; check the app on GitHub or add the account again"
	case http.StatusForbidden:
		msg += ". The app lacks a permission or was suspended; check its installation on GitHub"
	}
	return msg
}

func statusOf(err error) int {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae.Status
	}
	return 0
}

// RateLimitError says that the hourly API limit is used up.
type RateLimitError struct{ Until time.Time }

func (e *RateLimitError) Error() string {
	return "GitHub's API limit for this app is used up until " + e.Until.UTC().Format("15:04 UTC") +
		"; CI-Plane continues by itself then"
}

const maxAttempts = 4

// do sends a request, retrying network errors, 5xx and secondary rate
// limits with backoff. Answers outside 2xx come back as *apiError.
func (s *Service) do(ctx context.Context, c call) (*response, error) {
	var body []byte
	if c.body != nil {
		b, err := json.Marshal(c.body)
		if err != nil {
			return nil, err
		}
		body = b
	}
	key := strconv.FormatInt(c.account, 10) + "|" + c.path
	renewed := false
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 && c.once {
			break // a refused token is renewed without counting as an attempt
		}
		if attempt > 0 {
			wait := s.retryBase << (attempt - 1)
			wait += time.Duration(rand.Int64N(int64(wait)/2 + 1))
			if ra, ok := lastErr.(*retryAfter); ok && ra.d > wait {
				wait = ra.d
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(wait):
			}
		}
		if c.auth == authInstallation {
			if until := s.exhausted(c.account); !until.IsZero() {
				return nil, &RateLimitError{Until: until}
			}
		}
		req, err := http.NewRequestWithContext(ctx, c.method, s.APIURL+c.path, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("X-GitHub-Api-Version", apiVersion)
		req.Header.Set("User-Agent", "CI-Plane")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		switch c.auth {
		case authApp:
			jwt, err := s.appJWT(c.account)
			if err != nil {
				return nil, err
			}
			req.Header.Set("Authorization", "Bearer "+jwt)
		case authInstallation:
			tok, err := s.installationToken(ctx, c.account)
			if err != nil {
				return nil, err
			}
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		var cached condEntry
		if c.conditional {
			s.mu.Lock()
			cached = s.cond[key]
			s.mu.Unlock()
			if cached.etag != "" {
				req.Header.Set("If-None-Match", cached.etag)
			}
		}

		resp, err := s.HTTP.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastErr = fmt.Errorf("cannot reach GitHub (%s %s): %w", c.method, strings.SplitN(c.path, "?", 2)[0], unwrapURL(err))
			continue
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		resp.Body.Close()
		if err != nil {
			lastErr = fmt.Errorf("reading GitHub's answer to %s %s: %w", c.method, c.path, err)
			continue
		}
		if c.auth == authInstallation {
			s.noteRate(c.account, resp.Header)
		}
		r := &response{status: resp.StatusCode, header: resp.Header, body: data}

		switch {
		case resp.StatusCode == http.StatusNotModified && c.conditional && cached.etag != "":
			r.body, r.cached = cached.body, true
			return r, nil
		case resp.StatusCode >= 200 && resp.StatusCode < 300:
			if c.conditional {
				if et := resp.Header.Get("ETag"); et != "" {
					s.mu.Lock()
					s.cond[key] = condEntry{etag: et, body: data}
					s.mu.Unlock()
				}
			}
			return r, nil
		}

		ae := &apiError{Status: resp.StatusCode, Method: c.method, Path: c.path, Message: messageOf(data)}
		switch {
		case resp.StatusCode == http.StatusUnauthorized && c.auth == authInstallation && !renewed:
			// The token may have been revoked early; one fresh token.
			s.dropToken(c.account)
			renewed = true
			lastErr = ae
			attempt-- // not a transient failure, do not count it
			continue
		case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests:
			if resp.Header.Get("X-RateLimit-Remaining") == "0" {
				if reset := unixHeader(resp.Header, "X-RateLimit-Reset"); !reset.IsZero() {
					return nil, &RateLimitError{Until: reset}
				}
			}
			ra := retryAfterOf(resp.Header)
			if ra > 0 || strings.Contains(strings.ToLower(ae.Message), "secondary rate limit") {
				if ra > 2*time.Minute {
					return nil, &RateLimitError{Until: s.now().Add(ra)}
				}
				if ra == 0 {
					ra = time.Minute
				}
				lastErr = &retryAfter{d: ra, err: ae}
				continue
			}
			return nil, ae
		case resp.StatusCode >= 500:
			lastErr = ae
			continue
		}
		return nil, ae
	}
	if ra, ok := lastErr.(*retryAfter); ok {
		return nil, ra.err
	}
	return nil, lastErr
}

// retryAfter carries the wait GitHub asked for to the next attempt.
type retryAfter struct {
	d   time.Duration
	err error
}

func (r *retryAfter) Error() string { return r.err.Error() }

func retryAfterOf(h http.Header) time.Duration {
	v := h.Get("Retry-After")
	if v == "" {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 {
		return 0
	}
	return time.Duration(n) * time.Second
}

func unixHeader(h http.Header, name string) time.Time {
	n, err := strconv.ParseInt(h.Get(name), 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}
	}
	return time.Unix(n, 0)
}

func messageOf(body []byte) string {
	var m struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &m) == nil && m.Message != "" {
		return m.Message
	}
	s := strings.TrimSpace(string(body))
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return s
}

// unwrapURL drops the URL from a transport error; the message already says
// which call failed.
func unwrapURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// noteRate records the rate limit an installation has left.
func (s *Service) noteRate(id int64, h http.Header) {
	left, err := strconv.Atoi(h.Get("X-RateLimit-Remaining"))
	if err != nil {
		return
	}
	s.mu.Lock()
	hh := s.healthOf(id)
	hh.rateLeft = left
	hh.rateReset = unixHeader(h, "X-RateLimit-Reset")
	s.mu.Unlock()
}

// exhausted returns until when the rate limit of an installation is used
// up, or zero.
func (s *Service) exhausted(id int64) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.health[id]
	if h == nil || h.rateLeft != 0 || !h.rateReset.After(s.now()) {
		return time.Time{}
	}
	return h.rateReset
}

// getJSON sends c and decodes the answer into out.
func (s *Service) getJSON(ctx context.Context, c call, out any) (*response, error) {
	r, err := s.do(ctx, c)
	if err != nil {
		return nil, err
	}
	if out != nil && len(r.body) > 0 {
		if err := json.Unmarshal(r.body, out); err != nil {
			return nil, fmt.Errorf("GitHub's answer to %s %s is not understood: %w", c.method, strings.SplitN(c.path, "?", 2)[0], err)
		}
	}
	return r, nil
}

// repoPath turns owner/name into an escaped path.
func repoPath(full string) (string, error) {
	owner, name, ok := strings.Cut(full, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") {
		return "", fmt.Errorf("%q is not a repository name of the form owner/name", full)
	}
	return "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name), nil
}

// nextCursor returns the cursor of the rel="next" link, or "".
func nextCursor(h http.Header) string {
	for _, part := range strings.Split(h.Get("Link"), ",") {
		part = strings.TrimSpace(part)
		if !strings.Contains(part, `rel="next"`) {
			continue
		}
		start, end := strings.IndexByte(part, '<'), strings.IndexByte(part, '>')
		if start < 0 || end <= start {
			continue
		}
		u, err := url.Parse(part[start+1 : end])
		if err != nil {
			continue
		}
		return u.Query().Get("cursor")
	}
	return ""
}

// dropConditional forgets the cached answers of an account for addresses
// that start with prefix, except those that contain keep: a listing whose
// query moved on would otherwise keep its old answers for ever.
func (s *Service) dropConditional(account int64, prefix, keep string) {
	start := strconv.FormatInt(account, 10) + "|" + prefix
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.cond {
		if strings.HasPrefix(k, start) && !strings.Contains(k, keep) {
			delete(s.cond, k)
		}
	}
}
