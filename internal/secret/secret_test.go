package secret

import (
	"bytes"
	"errors"
	"testing"

	"github.com/saschazesiger/CI-Plane/internal/store"
)

func TestBox(t *testing.T) {
	dir := t.TempDir()
	a, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	sealed := a.Seal([]byte("private key"))
	if bytes.Contains(sealed, []byte("private")) {
		t.Fatal("not encrypted")
	}
	b, err := Load(dir) // same key file
	if err != nil {
		t.Fatal(err)
	}
	if plain, err := b.Open(sealed); err != nil || string(plain) != "private key" {
		t.Fatalf("open: %q %v", plain, err)
	}
	other, _ := Load(t.TempDir())
	if _, err := other.Open(sealed); err == nil {
		t.Fatal("opened with another key")
	}

	st, err := store.Open("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	err = st.Tx(func(tx *store.Tx) error {
		if _, err := a.Get(tx, "x"); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("unset secret: %v", err)
		}
		if err := a.Put(tx, "x", []byte("v")); err != nil {
			return err
		}
		v, err := a.Get(tx, "x")
		if err != nil || string(v) != "v" {
			t.Errorf("get: %q %v", v, err)
		}
		return a.Drop(tx, "x")
	})
	if err != nil {
		t.Fatal(err)
	}
}
