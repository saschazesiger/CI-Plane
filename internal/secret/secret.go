// Package secret encrypts what must not sit in the database in the clear:
// the private keys of the GitHub Apps, webhook secrets, the Cloudflare
// token and the SSH key.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/saschazesiger/CI-Plane/internal/store"
)

// Box encrypts and decrypts with one key (AES-256-GCM).
type Box struct{ aead cipher.AEAD }

// Load returns the box of an installation. The key comes from the
// environment variable CI_PLANE_SECRET_KEY (base64, 32 bytes) or from the
// file secret.key in dir, which is created on first use.
func Load(dir string) (*Box, error) {
	var key []byte
	if env := strings.TrimSpace(os.Getenv("CI_PLANE_SECRET_KEY")); env != "" {
		k, err := base64.StdEncoding.DecodeString(env)
		if err != nil || len(k) != 32 {
			return nil, errors.New("CI_PLANE_SECRET_KEY must be 32 bytes in base64 (openssl rand -base64 32)")
		}
		key = k
	} else {
		path := filepath.Join(dir, "secret.key")
		b, err := os.ReadFile(path)
		switch {
		case err == nil:
			k, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b)))
			if err != nil || len(k) != 32 {
				return nil, fmt.Errorf("%s is damaged: it must hold 32 bytes in base64", path)
			}
			key = k
		case os.IsNotExist(err):
			key = make([]byte, 32)
			if _, err := rand.Read(key); err != nil {
				return nil, err
			}
			if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(key)+"\n"), 0o600); err != nil {
				return nil, fmt.Errorf("write %s: %w", path, err)
			}
		default:
			return nil, err
		}
	}
	return New(key)
}

// New returns a box for a 32-byte key.
func New(key []byte) (*Box, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Seal encrypts plain.
func (b *Box) Seal(plain []byte) []byte {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	return b.aead.Seal(nonce, nonce, plain, nil)
}

// Open decrypts what Seal returned.
func (b *Box) Open(sealed []byte) ([]byte, error) {
	n := b.aead.NonceSize()
	if len(sealed) < n {
		return nil, errors.New("secret: value too short")
	}
	plain, err := b.aead.Open(nil, sealed[:n], sealed[n:], nil)
	if err != nil {
		return nil, errors.New("secret: cannot decrypt (was the secret key changed?)")
	}
	return plain, nil
}

// Put stores a secret under "secret:<name>".
func (b *Box) Put(tx *store.Tx, name string, plain []byte) error {
	return tx.Set("secret:"+name, b.Seal(plain))
}

// Get reads a secret; store.ErrNotFound if it was never stored.
func (b *Box) Get(tx *store.Tx, name string) ([]byte, error) {
	sealed, err := tx.Get("secret:" + name)
	if err != nil {
		return nil, err
	}
	return b.Open(sealed)
}

// Drop deletes a secret.
func (b *Box) Drop(tx *store.Tx, name string) error { return tx.Delete("secret:" + name) }
