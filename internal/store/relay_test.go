package store

import (
	"testing"

	"github.com/saschazesiger/CI-Plane/internal/model"
)

func TestRepoKeepsItsFailoverAcrossSyncs(t *testing.T) {
	s, err := Open("")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	err = s.Tx(func(tx *Tx) error {
		if err := tx.UpsertRepo(model.Repo{ID: 1, AccountID: 1, FullName: "acme/api", Private: true, Enabled: true}); err != nil {
			return err
		}
		p, err := tx.Repo(1)
		if err != nil {
			return err
		}
		p.Relay, p.RelayOff, p.RelayOffAt = true, "", 0
		if err := tx.SaveRepo(p); err != nil {
			return err
		}
		// A sync of the installation keeps the person's choice.
		if err := tx.UpsertRepo(model.Repo{ID: 1, AccountID: 1, FullName: "acme/api-renamed", Private: true, Enabled: true}); err != nil {
			return err
		}
		if p, err = tx.Repo(1); err != nil || !p.Relay || p.FullName != "acme/api-renamed" {
			t.Fatalf("after a sync: %+v %v", p, err)
		}
		p.Relay, p.RelayOff, p.RelayOffAt = false, "minutes used up", 42
		if err := tx.SaveRepo(p); err != nil {
			return err
		}
		if p, err = tx.Repo(1); err != nil || p.Relay || p.RelayOff != "minutes used up" || p.RelayOffAt != 42 {
			t.Fatalf("switched off: %+v %v", p, err)
		}
		for _, k := range []string{"secret:relay:a", "secret:relay:b", "secret:other", "relay"} {
			if err := tx.Set(k, []byte("x")); err != nil {
				return err
			}
		}
		keys, err := tx.Keys("secret:relay:")
		if err != nil || len(keys) != 2 || keys[0] != "secret:relay:a" {
			t.Fatalf("keys: %v %v", keys, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
