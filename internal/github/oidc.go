package github

import (
	"context"
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
	"sync"
	"time"
)

// actionsIssuer issues the OIDC tokens of GitHub Actions.
const actionsIssuer = "https://token.actions.githubusercontent.com"

// oidcClaims are the claims of an Actions OIDC token CI-Plane looks at.
type oidcClaims struct {
	Issuer       string          `json:"iss"`
	Audience     json.RawMessage `json:"aud"` // a string or a list
	Expires      int64           `json:"exp"`
	NotBefore    int64           `json:"nbf"`
	IssuedAt     int64           `json:"iat"`
	Repository   string          `json:"repository"`
	RepositoryID string          `json:"repository_id"`
	RunID        string          `json:"run_id"`
	RunAttempt   string          `json:"run_attempt"`
	WorkflowRef  string          `json:"workflow_ref"`
	// JobWorkflowRef is the workflow file the job comes from: for a job of
	// a reusable workflow, that workflow, not the one that called it.
	JobWorkflowRef string `json:"job_workflow_ref"`
	EventName      string `json:"event_name"`
	Actor          string `json:"actor"`
	// RunnerEnvironment is "github-hosted" on a machine of GitHub\'s own.
	RunnerEnvironment string `json:"runner_environment"`
}

func (c oidcClaims) hasAudience(want string) bool {
	var one string
	if json.Unmarshal(c.Audience, &one) == nil {
		return one == want
	}
	var many []string
	if json.Unmarshal(c.Audience, &many) == nil {
		for _, a := range many {
			if a == want {
				return true
			}
		}
	}
	return false
}

// oidcVerifier checks tokens of one issuer against its published keys.
type oidcVerifier struct {
	issuer string
	http   *http.Client
	now    func() time.Time

	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey // by key id
	fetched time.Time
}

func newOIDCVerifier(issuer string, client *http.Client, now func() time.Time) *oidcVerifier {
	return &oidcVerifier{issuer: issuer, http: client, now: now}
}

// errToken is a token that is not valid; its text goes back to the caller.
type errToken struct{ msg string }

func (e errToken) Error() string { return e.msg }

// verify checks the signature, issuer, audience and times of a token and
// returns its claims.
func (v *oidcVerifier) verify(ctx context.Context, token, audience string) (oidcClaims, error) {
	var c oidcClaims
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return c, errToken{"the token is not a JWT"}
	}
	var head struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := decodeSegment(parts[0], &head); err != nil {
		return c, errToken{"the token's header is not readable"}
	}
	if head.Alg != "RS256" {
		return c, errToken{"the token is not signed with RS256"}
	}
	key, err := v.key(ctx, head.Kid)
	if err != nil {
		return c, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return c, errToken{"the token's signature is not readable"}
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(key, crypto.SHA256, sum[:], sig); err != nil {
		return c, errToken{"the token's signature is wrong"}
	}
	if err := decodeSegment(parts[1], &c); err != nil {
		return c, errToken{"the token's claims are not readable"}
	}
	now := v.now().Unix()
	const skew = 60
	switch {
	case c.Issuer != v.issuer:
		return c, errToken{"the token was not issued by GitHub Actions"}
	case !c.hasAudience(audience):
		return c, errToken{"the token is meant for someone else (audience)"}
	case c.Expires == 0 || now > c.Expires+skew:
		return c, errToken{"the token has expired"}
	case c.NotBefore > now+skew || c.IssuedAt > now+skew:
		return c, errToken{"the token is not valid yet"}
	}
	return c, nil
}

func decodeSegment(seg string, out any) error {
	b, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

// key returns the public key with that id, fetching the issuer's keys when
// it does not know it. GitHub rotates them now and then.
func (v *oidcVerifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.Lock()
	k, ok := v.keys[kid]
	fresh := v.now().Sub(v.fetched) < time.Minute
	stale := v.now().Sub(v.fetched) > 6*time.Hour
	v.mu.Unlock()
	if ok && !stale {
		return k, nil
	}
	if !ok && fresh {
		return nil, errToken{"the token was signed with a key GitHub does not publish"}
	}
	keys, err := v.fetch(ctx)
	if err != nil {
		if ok {
			return k, nil // keep using what was there
		}
		return nil, err
	}
	v.mu.Lock()
	v.keys, v.fetched = keys, v.now()
	v.mu.Unlock()
	if k, ok = keys[kid]; !ok {
		return nil, errToken{"the token was signed with a key GitHub does not publish"}
	}
	return k, nil
}

func (v *oidcVerifier) fetch(ctx context.Context) (map[string]*rsa.PublicKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.issuer+"/.well-known/jwks", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "CI-Plane")
	resp, err := v.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cannot fetch the keys of GitHub Actions: %w", unwrapURL(err))
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("cannot fetch the keys of GitHub Actions: status %d", resp.StatusCode)
	}
	var set struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(body, &set); err != nil {
		return nil, fmt.Errorf("the keys of GitHub Actions are not understood: %w", err)
	}
	out := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "RSA" {
			continue
		}
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil || len(e) == 0 || len(e) > 4 {
			continue
		}
		exp := int(new(big.Int).SetBytes(e).Int64())
		out[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: exp}
	}
	if len(out) == 0 {
		return nil, errors.New("GitHub Actions publishes no RSA keys")
	}
	return out, nil
}
