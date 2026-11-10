package cloudflare

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// clockSkew is how far exp and nbf may be off between Cloudflare and us.
const clockSkew = time.Minute

// Authenticate checks the Cloudflare Access token of a request that came
// through the tunnel and returns the e-mail of the user. Cloudflare already
// checked it at the edge; checking again means a request that reaches the
// tunnel listener some other way is not trusted.
func (s *Service) Authenticate(r *http.Request) (string, error) {
	s.mu.Lock()
	cur := s.cur
	s.mu.Unlock()
	if cur.TeamDomain == "" || cur.AppAUD == "" {
		return "", errors.New("the Cloudflare login is not set up")
	}
	raw := strings.TrimSpace(r.Header.Get("Cf-Access-Jwt-Assertion"))
	if raw == "" {
		return "", errors.New("no Cloudflare Access token in the request")
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return "", errors.New("malformed Access token")
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := decodePart(parts[0], &hdr); err != nil {
		return "", errors.New("malformed Access token header")
	}
	// Only RS256: accepting what the token names would let "none" or an
	// HMAC with the public key as secret through.
	if hdr.Alg != "RS256" {
		return "", fmt.Errorf("access token uses %q, only RS256 is accepted", hdr.Alg)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", errors.New("malformed Access token signature")
	}
	key, err := s.key(cur.TeamDomain, hdr.Kid)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, sum[:], sig); err != nil {
		return "", errors.New("access token signature is not valid")
	}

	var c struct {
		Iss   string          `json:"iss"`
		Aud   json.RawMessage `json:"aud"`
		Exp   *float64        `json:"exp"`
		Nbf   *float64        `json:"nbf"`
		Email string          `json:"email"`
	}
	if err := decodePart(parts[1], &c); err != nil {
		return "", errors.New("malformed Access token claims")
	}
	if strings.TrimSuffix(c.Iss, "/") != "https://"+cur.TeamDomain {
		return "", fmt.Errorf("access token was issued by %q, not by this team", c.Iss)
	}
	var auds []string
	if err := json.Unmarshal(c.Aud, &auds); err != nil {
		var one string
		if json.Unmarshal(c.Aud, &one) != nil {
			return "", errors.New("access token has no audience")
		}
		auds = []string{one}
	}
	found := false
	for _, a := range auds {
		found = found || a == cur.AppAUD
	}
	if !found {
		return "", errors.New("access token is for another Access application")
	}
	now := s.now()
	if c.Exp == nil || now.After(time.Unix(int64(*c.Exp), 0).Add(clockSkew)) {
		return "", errors.New("access token has expired; reload the page to sign in again")
	}
	if c.Nbf != nil && now.Add(clockSkew).Before(time.Unix(int64(*c.Nbf), 0)) {
		return "", errors.New("access token is not valid yet")
	}
	for _, e := range cur.Emails {
		if c.Email != "" && strings.EqualFold(e, c.Email) {
			return e, nil
		}
	}
	return "", fmt.Errorf("%s may not sign in to CI-Plane", c.Email)
}

func decodePart(p string, v any) error {
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(p, "="))
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// key returns the signing key with that id, fetching the key set when the
// id is unknown or the set is old. Fetches are at least KeysMinRefresh apart
// so a flood of tokens with made-up ids cannot make us hammer Cloudflare.
func (s *Service) key(team, kid string) (*rsa.PublicKey, error) {
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	now := s.now()
	if s.keysTeam != team {
		s.keys, s.keysTeam, s.keysAt, s.keysTryAt = nil, team, time.Time{}, time.Time{}
	}
	k, known := s.keys[kid]
	stale := now.Sub(s.keysAt) > s.KeysMaxAge
	if (!known || stale) && now.Sub(s.keysTryAt) >= s.KeysMinRefresh {
		s.keysTryAt = now
		keys, err := s.fetchKeys(team)
		if err != nil {
			s.logf("cloudflare: cannot fetch the Access signing keys: %v", err)
		} else {
			s.keys, s.keysAt = keys, now
			k, known = keys[kid]
		}
	}
	if !known {
		return nil, errors.New("access token is signed with an unknown key")
	}
	return k, nil
}

func (s *Service) fetchKeys(team string) (map[string]*rsa.PublicKey, error) {
	resp, err := s.HTTP.Get(s.CertsURL(team))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var set struct {
		Keys []struct {
			Kid string `json:"kid"`
			Kty string `json:"kty"`
			Alg string `json:"alg"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&set); err != nil {
		return nil, err
	}
	out := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "RSA" || (k.Alg != "" && k.Alg != "RS256") {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil || len(e) == 0 || len(e) > 4 {
			continue
		}
		pub := &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
		if pub.N.BitLen() < 2048 {
			continue
		}
		out[k.Kid] = pub
	}
	if len(out) == 0 {
		return nil, errors.New("no usable RSA keys in the key set")
	}
	return out, nil
}
