package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// apiError is a failed call to the Cloudflare API.
type apiError struct {
	Status int
	Method string
	Path   string
	Errors []cfMessage
}

type cfMessage struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string {
	var msgs []string
	for _, m := range e.Errors {
		msgs = append(msgs, fmt.Sprintf("%s (code %d)", m.Message, m.Code))
	}
	if len(msgs) == 0 {
		msgs = append(msgs, http.StatusText(e.Status))
	}
	return fmt.Sprintf("Cloudflare answered %d to %s %s: %s", e.Status, e.Method, e.Path, strings.Join(msgs, "; "))
}

func isNotFound(err error) bool {
	var e *apiError
	return errors.As(err, &e) && e.Status == http.StatusNotFound
}

// isDenied reports a token that is invalid or lacks a permission. Cloudflare
// answers 403 with code 10000 ("Authentication error") for a missing
// permission and 400/401 with code 1000/6003/6111 for a malformed token.
func isDenied(err error) bool {
	var e *apiError
	if !errors.As(err, &e) {
		return false
	}
	if e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden {
		return true
	}
	for _, m := range e.Errors {
		switch m.Code {
		case 1000, 6003, 6111, 9106, 9109, 10000:
			return true
		}
	}
	return false
}

// missing turns a permission failure into a sentence that names the
// permission; other errors pass through.
func missing(err error, perm string) error {
	if err == nil || !isDenied(err) {
		return err
	}
	return fmt.Errorf("the API token is not allowed to do this. It needs the permission %q. "+
		"Create a new token with the link on this page (it fills in every permission) and paste it here. Details: %w", perm, err)
}

// call sends one request to the Cloudflare API and decodes "result" into
// out (if not nil). It does not retry: every caller is part of a step that
// is safe to run again.
func (s *Service) call(ctx context.Context, token, method, path string, query url.Values, body, out any) error {
	u := s.API + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach the Cloudflare API (%s %s): %w. Check the internet connection of this machine", method, path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return fmt.Errorf("reading the answer of the Cloudflare API to %s %s: %w", method, path, err)
	}
	var env struct {
		Success bool            `json:"success"`
		Errors  []cfMessage     `json:"errors"`
		Result  json.RawMessage `json:"result"`
	}
	if jerr := json.Unmarshal(raw, &env); jerr != nil {
		if resp.StatusCode >= 300 {
			return &apiError{Status: resp.StatusCode, Method: method, Path: path}
		}
		return fmt.Errorf("the Cloudflare API sent an unexpected answer to %s %s", method, path)
	}
	if resp.StatusCode >= 300 || !env.Success {
		st := resp.StatusCode
		if st < 300 {
			st = http.StatusBadRequest
		}
		return &apiError{Status: st, Method: method, Path: path, Errors: env.Errors}
	}
	if out != nil && len(env.Result) > 0 && string(env.Result) != "null" {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return fmt.Errorf("the Cloudflare API sent an unexpected answer to %s %s: %w", method, path, err)
		}
	}
	return nil
}

// list fetches every page of a list endpoint.
func list[T any](ctx context.Context, s *Service, token, path string, query url.Values) ([]T, error) {
	var all []T
	q := url.Values{}
	for k, v := range query {
		q[k] = v
	}
	for page := 1; page <= 100; page++ {
		q.Set("page", fmt.Sprint(page))
		q.Set("per_page", "50")
		var items []T
		if err := s.call(ctx, token, http.MethodGet, path, q, nil, &items); err != nil {
			return nil, err
		}
		all = append(all, items...)
		if len(items) < 50 {
			break
		}
	}
	return all, nil
}

// --- the objects we use, with only the fields we need ------------------------

type zoneObj struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Account struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"account"`
}

type orgObj struct {
	AuthDomain string `json:"auth_domain"`
}

type idpObj struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

type tunnelObj struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	ConfigSrc string  `json:"config_src"`
	DeletedAt *string `json:"deleted_at"`
}

type ingressRule struct {
	Hostname string `json:"hostname,omitempty"`
	Service  string `json:"service"`
}

type recordObj struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Proxied bool   `json:"proxied"`
	TTL     int    `json:"ttl"`
	Comment string `json:"comment"`
}

type ruleEmail struct {
	Email struct {
		Email string `json:"email"`
	} `json:"email"`
}

type policyObj struct {
	ID              string `json:"id,omitempty"`
	Name            string `json:"name"`
	Decision        string `json:"decision"`
	Include         []any  `json:"include"`
	SessionDuration string `json:"session_duration,omitempty"`
}

type policyRef struct {
	ID         string `json:"id"`
	Precedence int    `json:"precedence"`
}

type destination struct {
	Type string `json:"type"`
	URI  string `json:"uri"`
}

type appObj struct {
	ID              string        `json:"id,omitempty"`
	AUD             string        `json:"aud,omitempty"`
	Name            string        `json:"name"`
	Domain          string        `json:"domain"`
	Type            string        `json:"type"`
	Destinations    []destination `json:"destinations,omitempty"`
	SessionDuration string        `json:"session_duration,omitempty"`
	Policies        []any         `json:"policies"`
	AppLauncher     bool          `json:"app_launcher_visible"`
}
