package store

import (
	"errors"

	zstore "github.com/saschazesiger/Z-Dash/server/store"
)

// ServerKV is the kv table as the Z-Dash server keeps its own state in it:
// the admin password (auth.password), the sessions (auth.sessions) and the
// tunnel (cloudflare:*). They are the keys and formats CI-Plane used before
// it ran on the server, so an update keeps the password and the sessions.
type ServerKV struct{ St *Store }

// Get reads a key; the server's ErrNotFound when it is not there.
func (k ServerKV) Get(key string) ([]byte, error) {
	var v []byte
	err := k.St.View(func(tx *Tx) error {
		var err error
		v, err = tx.Get(key)
		return err
	})
	if errors.Is(err, ErrNotFound) {
		return nil, zstore.ErrNotFound
	}
	return v, err
}

// Set writes a key.
func (k ServerKV) Set(key string, value []byte) error {
	return k.St.Tx(func(tx *Tx) error { return tx.Set(key, value) })
}

// SetIfMissing writes a key only when it is not there, in one transaction.
func (k ServerKV) SetIfMissing(key string, value []byte) (bool, error) {
	won := false
	err := k.St.Tx(func(tx *Tx) error {
		if _, err := tx.Get(key); err == nil {
			return nil
		} else if !errors.Is(err, ErrNotFound) {
			return err
		}
		won = true
		return tx.Set(key, value)
	})
	return won, err
}

// Delete removes a key; a missing key is no error.
func (k ServerKV) Delete(key string) error {
	return k.St.Tx(func(tx *Tx) error { return tx.Delete(key) })
}
