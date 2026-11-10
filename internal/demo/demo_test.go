package demo

import (
	"context"
	"testing"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

func TestDemoRunsJobs(t *testing.T) {
	d, err := New(Options{Seed: 1, Speed: 20, Logf: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	var seeded map[string]int
	_ = d.Store.View(func(tx *store.Tx) error { seeded, err = tx.JobCounts(); return err })
	if seeded[model.JobCompleted] < 20 {
		t.Fatalf("history: %v", seeded)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go d.Run(ctx)
	for ctx.Err() == nil {
		var counts map[string]int
		_ = d.Store.View(func(tx *store.Tx) error { counts, err = tx.JobCounts(); return err })
		if counts[model.JobCompleted] > seeded[model.JobCompleted] {
			return // a live job was queued, started and completed
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("no live job completed")
}

func TestFreshDemoIsEmpty(t *testing.T) {
	d, err := New(Options{Fresh: true})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	_ = d.Store.View(func(tx *store.Tx) error {
		ws, _ := tx.Workers()
		as, _ := tx.Accounts()
		if len(ws)+len(as) != 0 {
			t.Errorf("fresh demo has %d workers and %d accounts", len(ws), len(as))
		}
		return nil
	})
	if d.Cloudflare.Status().Configured {
		t.Error("fresh demo has a tunnel")
	}
}
