package cloudflare

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// verifyRetry checks from outside until it passes or VerifyFor is over: a
// new DNS name and the edge configuration take a moment to be everywhere.
func (s *Service) verifyRetry(ctx context.Context, host string) error {
	deadline := s.now().Add(s.VerifyFor)
	for {
		err := s.verifyOnce(ctx, host)
		s.setVerified(err)
		if err == nil {
			return nil
		}
		if s.now().After(deadline) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.VerifyPause):
		}
	}
}

func (s *Service) setVerified(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.verified = err == nil
	s.verifyErr = ""
	if err != nil {
		s.verifyErr = err.Error()
	}
}

// verifyOnce asks https://host/ and https://host/webhook without
// credentials, as GitHub or a stranger would.
func (s *Service) verifyOnce(ctx context.Context, host string) error {
	get := func(path string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+host+path, nil)
		if err != nil {
			return nil, err
		}
		resp, err := s.Outside.Do(req)
		if err != nil {
			return nil, err
		}
		io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()
		return resp, nil
	}

	resp, err := get("/")
	if err != nil {
		return fmt.Errorf("https://%s/ cannot be reached from here (%v). The DNS record may not be visible yet; "+
			"if this stays, check the record %s in the Cloudflare dashboard", host, unwrapURL(err), host)
	}
	if err := checkLogin(host, resp); err != nil {
		return err
	}

	resp, err = get("/webhook")
	if err != nil {
		return fmt.Errorf("https://%s/webhook cannot be reached from here: %v", host, unwrapURL(err))
	}
	if err := checkWebhook(host, resp); err != nil {
		return err
	}
	return nil
}

func checkLogin(host string, resp *http.Response) error {
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		loc, _ := url.Parse(resp.Header.Get("Location"))
		if loc != nil && (strings.HasSuffix(strings.ToLower(loc.Hostname()), ".cloudflareaccess.com") ||
			strings.HasPrefix(loc.Path, "/cdn-cgi/access/")) {
			return nil
		}
		return fmt.Errorf("https://%s/ redirects to %q instead of the Cloudflare Access login. Something else "+
			"(a redirect rule or page rule) is in front of the tunnel; check the rules of the domain", host, resp.Header.Get("Location"))
	}
	if resp.Header.Get("X-CI-Plane") != "" || resp.StatusCode < 300 {
		return fmt.Errorf("https://%s/ answered without asking for a login (status %d): Cloudflare Access is not protecting it. "+
			"Run the Cloudflare setup again; it recreates the Access application", host, resp.StatusCode)
	}
	return fmt.Errorf("https://%s/ answered %d instead of asking for a login. %s", host, resp.StatusCode, edgeHint(resp.StatusCode))
}

func checkWebhook(host string, resp *http.Response) error {
	if resp.StatusCode == http.StatusOK && resp.Header.Get("X-CI-Plane") == "webhook" {
		return nil
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 &&
		strings.Contains(strings.ToLower(resp.Header.Get("Location")), "cloudflareaccess.com") {
		return fmt.Errorf("https://%s/webhook asks for a login, so GitHub could not deliver events. The Access "+
			"application for /webhook (Bypass) is missing or not in effect; run the Cloudflare setup again", host)
	}
	if resp.Header.Get("X-CI-Plane") != "" || resp.StatusCode == http.StatusOK {
		return fmt.Errorf("https://%s/webhook reaches CI-Plane but not its webhook handler (status %d)", host, resp.StatusCode)
	}
	return fmt.Errorf("https://%s/webhook answered %d instead of reaching CI-Plane. %s", host, resp.StatusCode, edgeHint(resp.StatusCode))
}

// edgeHint explains the statuses Cloudflare's edge sends for tunnel trouble.
func edgeHint(code int) string {
	switch code {
	case 530, 1033:
		return "Cloudflare cannot find a running connector for the tunnel: cloudflared is not connected, or the DNS record points at another tunnel."
	case 502, 503, 504:
		return "cloudflared is connected but cannot reach CI-Plane behind it; the tunnel's routing may point to the wrong address."
	case 404:
		return "The tunnel does not route this hostname; run the Cloudflare setup again to fix the routing."
	default:
		return "It may take a minute after setup; if it stays, run the Cloudflare setup again."
	}
}

func unwrapURL(err error) error {
	var u *url.Error
	if errors.As(err, &u) {
		return u.Err
	}
	return err
}
