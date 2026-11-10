package github

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/store"
)

// tokenRenewBefore is how long before its expiry an installation token is
// replaced, so that no request starts with a token about to expire.
const tokenRenewBefore = 5 * time.Minute

// tokenSlot holds the installation token of one app. fetch is a lock that
// lets only one caller ask GitHub for a new token while the others wait.
type tokenSlot struct {
	fetch   chan struct{}
	token   string // guarded by Service.mu
	expires time.Time
}

// privateKey returns the parsed private key of an app.
func (s *Service) privateKey(id int64) (*rsa.PrivateKey, error) {
	s.mu.Lock()
	k := s.keys[id]
	s.mu.Unlock()
	if k != nil {
		return k, nil
	}
	var raw []byte
	err := s.st.View(func(tx *store.Tx) error {
		var err error
		raw, err = s.box.Get(tx, keyName(id))
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("the private key of the GitHub App %d is missing; remove the account and add it again", id)
	}
	if err != nil {
		return nil, err
	}
	k, err = parseKey(raw)
	if err != nil {
		return nil, fmt.Errorf("the private key of the GitHub App %d is damaged (%v); remove the account and add it again", id, err)
	}
	s.mu.Lock()
	s.keys[id] = k
	s.mu.Unlock()
	return k, nil
}

func parseKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("not PEM")
	}
	if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return k, nil
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("not an RSA key")
	}
	return rk, nil
}

// appJWT signs a JSON Web Token (RS256) that authenticates as the app. It
// is issued a minute in the past against clock drift and lives 9 of the
// allowed 10 minutes.
func (s *Service) appJWT(id int64) (string, error) {
	key, err := s.privateKey(id)
	if err != nil {
		return "", err
	}
	now := s.now().Unix()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	claims, _ := json.Marshal(map[string]any{"iat": now - 60, "exp": now + 9*60, "iss": strconv.FormatInt(id, 10)})
	signing := header + "." + base64.RawURLEncoding.EncodeToString(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

func (s *Service) slot(id int64) *tokenSlot {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.tokens[id]
	if t == nil {
		t = &tokenSlot{fetch: make(chan struct{}, 1)}
		s.tokens[id] = t
	}
	return t
}

func (s *Service) cachedToken(t *tokenSlot) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.token != "" && s.now().Add(tokenRenewBefore).Before(t.expires) {
		return t.token
	}
	return ""
}

// installationToken returns a valid token of the app's installation,
// asking GitHub for a new one only when the cached one is about to expire.
func (s *Service) installationToken(ctx context.Context, id int64) (string, error) {
	t := s.slot(id)
	if tok := s.cachedToken(t); tok != "" {
		return tok, nil
	}
	select {
	case t.fetch <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	defer func() { <-t.fetch }()
	// Another caller may have fetched it while this one waited.
	if tok := s.cachedToken(t); tok != "" {
		return tok, nil
	}
	acc, err := s.account(id)
	if err != nil {
		return "", err
	}
	if acc.InstallationID == 0 {
		return "", fmt.Errorf("the GitHub App %s is not installed yet; install it on the repositories CI-Plane should serve", acc.Slug)
	}
	var out struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	_, err = s.getJSON(ctx, call{
		method: http.MethodPost, path: "/app/installations/" + strconv.FormatInt(acc.InstallationID, 10) + "/access_tokens",
		auth: authApp, account: id,
	}, &out)
	if statusOf(err) == http.StatusNotFound {
		return "", fmt.Errorf("the GitHub App %s is no longer installed; install it again", acc.Slug)
	}
	if err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", errors.New("GitHub did not return an installation token; try again in a minute")
	}
	if out.ExpiresAt.IsZero() {
		out.ExpiresAt = s.now().Add(time.Hour)
	}
	s.mu.Lock()
	t.token, t.expires = out.Token, out.ExpiresAt
	s.mu.Unlock()
	return out.Token, nil
}

// dropToken forgets the token of an app, so the next call fetches one.
func (s *Service) dropToken(id int64) {
	s.mu.Lock()
	if t := s.tokens[id]; t != nil {
		t.token = ""
	}
	s.mu.Unlock()
}
