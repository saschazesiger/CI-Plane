package cloudflare

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type jwks struct {
	mu      sync.Mutex
	keys    map[string]*rsa.PrivateKey
	fetches atomic.Int32
}

func (j *jwks) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	j.fetches.Add(1)
	j.mu.Lock()
	defer j.mu.Unlock()
	var out struct {
		Keys []map[string]string `json:"keys"`
	}
	for kid, k := range j.keys {
		out.Keys = append(out.Keys, map[string]string{
			"kid": kid, "kty": "RSA", "alg": "RS256", "use": "sig",
			"n": base64.RawURLEncoding.EncodeToString(k.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(k.E)).Bytes()),
		})
	}
	json.NewEncoder(w).Encode(out)
}

func newKey(t *testing.T) *rsa.PrivateKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func sign(t *testing.T, k *rsa.PrivateKey, hdr, claims map[string]any) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	in := enc(hdr) + "." + enc(claims)
	sum := sha256.Sum256([]byte(in))
	sig, err := rsa.SignPKCS1v15(rand.Reader, k, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return in + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func TestAuthenticate(t *testing.T) {
	h := newHarness(t, false)
	s := h.svc
	k1, k2, other := newKey(t), newKey(t), newKey(t)
	set := &jwks{keys: map[string]*rsa.PrivateKey{"k1": k1}}
	srv := httptest.NewServer(set)
	defer srv.Close()
	var certsFor string
	s.CertsURL = func(team string) string { certsFor = team; return srv.URL }
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	s.mu.Lock()
	s.cur = state{Ready: true, TeamDomain: testTeam, AppAUD: "aud-main", Emails: []string{"alice@example.com"}}
	s.mu.Unlock()

	claims := func(mod func(map[string]any)) map[string]any {
		c := map[string]any{
			"iss": "https://" + testTeam, "aud": []string{"aud-main"}, "email": "Alice@Example.com",
			"exp": now.Add(time.Hour).Unix(), "nbf": now.Add(-time.Minute).Unix(), "iat": now.Add(-time.Minute).Unix(),
			"sub": "u1", "type": "app",
		}
		if mod != nil {
			mod(c)
		}
		return c
	}
	hdr := func(kid string) map[string]any { return map[string]any{"alg": "RS256", "kid": kid, "typ": "JWT"} }
	check := func(name, tok string, wantOK bool, wantErr string) {
		t.Helper()
		r := httptest.NewRequest("GET", "/", nil)
		if tok != "" {
			r.Header.Set("Cf-Access-Jwt-Assertion", tok)
		}
		email, err := s.Authenticate(r)
		switch {
		case wantOK && (err != nil || email != "alice@example.com"):
			t.Errorf("%s: email %q, err %v", name, email, err)
		case !wantOK && err == nil:
			t.Errorf("%s: accepted", name)
		case !wantOK && wantErr != "" && !strings.Contains(err.Error(), wantErr):
			t.Errorf("%s: err %v, want %q", name, err, wantErr)
		}
	}

	check("valid", sign(t, k1, hdr("k1"), claims(nil)), true, "")
	if certsFor != testTeam {
		t.Errorf("keys fetched for %q", certsFor)
	}
	check("audience as string", sign(t, k1, hdr("k1"), claims(func(c map[string]any) { c["aud"] = "aud-main" })), true, "")
	check("no token", "", false, "no Cloudflare Access token")
	check("wrong audience", sign(t, k1, hdr("k1"), claims(func(c map[string]any) { c["aud"] = []string{"aud-webhook"} })), false, "another Access application")
	check("wrong issuer", sign(t, k1, hdr("k1"), claims(func(c map[string]any) { c["iss"] = "https://evil.cloudflareaccess.com" })), false, "issued by")
	check("expired", sign(t, k1, hdr("k1"), claims(func(c map[string]any) { c["exp"] = now.Add(-2 * time.Minute).Unix() })), false, "expired")
	check("no exp", sign(t, k1, hdr("k1"), claims(func(c map[string]any) { delete(c, "exp") })), false, "expired")
	check("not yet", sign(t, k1, hdr("k1"), claims(func(c map[string]any) { c["nbf"] = now.Add(10 * time.Minute).Unix() })), false, "not valid yet")
	check("email not allowed", sign(t, k1, hdr("k1"), claims(func(c map[string]any) { c["email"] = "mallory@example.com" })), false, "may not sign in")
	check("no email", sign(t, k1, hdr("k1"), claims(func(c map[string]any) { delete(c, "email") })), false, "may not sign in")
	check("bad signature", sign(t, other, hdr("k1"), claims(nil)), false, "signature")
	good := sign(t, k1, hdr("k1"), claims(nil))
	parts := strings.Split(good, ".")
	forged := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"https://`+testTeam+`","aud":"aud-main","email":"alice@example.com","exp":9999999999}`)) + "." + parts[2]
	check("changed claims", forged, false, "signature")
	none := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","kid":"k1"}`)) + "." + parts[1] + "."
	check("alg none", none, false, "only RS256")
	hs := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","kid":"k1"}`)) + "." + parts[1] + "." + parts[2]
	check("alg HS256", hs, false, "only RS256")
	check("garbage", "a.b", false, "malformed")
	if n := set.fetches.Load(); n != 1 {
		t.Errorf("%d key fetches so far, want 1", n)
	}

	// Cloudflare rotates: a token with a new key id makes us fetch once.
	set.mu.Lock()
	set.keys["k2"] = k2
	set.mu.Unlock()
	now = now.Add(time.Minute) // past the minimum refresh interval
	check("rotated key", sign(t, k2, hdr("k2"), claims(nil)), true, "")
	if n := set.fetches.Load(); n != 2 {
		t.Errorf("%d key fetches after rotation, want 2", n)
	}
	// A flood of unknown key ids fetches at most once per interval.
	now = now.Add(time.Minute)
	for i := 0; i < 20; i++ {
		check("unknown key", sign(t, other, hdr("k9"), claims(nil)), false, "unknown key")
	}
	if n := set.fetches.Load(); n != 3 {
		t.Errorf("%d key fetches after a flood, want 3", n)
	}
	// Old keys are fetched again after KeysMaxAge even if the id is known.
	now = now.Add(2 * time.Hour)
	check("valid after max age", sign(t, k1, hdr("k1"), claims(nil)), true, "")
	if n := set.fetches.Load(); n != 4 {
		t.Errorf("%d key fetches after max age, want 4", n)
	}

	// The e-mail list follows SetEmails; without setup nothing passes.
	s.mu.Lock()
	s.cur = state{}
	s.mu.Unlock()
	check("not set up", sign(t, k1, hdr("k1"), claims(nil)), false, "not set up")
}
