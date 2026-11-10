package node

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// The janitor keeps a worker tidy: current images, no superseded ones, a
// mirror under its cap. It only touches images CI-Plane pulled itself and
// objects labelled ci-plane.role; runner leftovers are the engine's job.

const refreshEvery = 24 * time.Hour

type janitor struct {
	mu        sync.Mutex // one pass per worker at a time
	refreshed time.Time
	last      time.Time
}

func (m *Manager) janitorOf(id int64) *janitor {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.jan[id]
	if j == nil {
		j = &janitor{}
		m.jan[id] = j
	}
	return j
}

// janitorLoop runs a pass every janitorEvery, and early when the disk runs
// low.
func (m *Manager) janitorLoop(ctx context.Context, c *conn) {
	tick := time.NewTicker(min(30*time.Second, m.janitorEvery))
	defer tick.Stop()
	start := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		st := c.Status()
		if !st.Connected || st.At == 0 {
			continue
		}
		w := c.worker()
		j := m.janitorOf(w.ID)
		j.mu.Lock()
		last := j.last
		j.mu.Unlock()
		if last.IsZero() {
			last = start
		}
		low := st.DiskFreeMB > 0 && st.DiskFreeMB < m.settings().MinDiskFreeMB
		if time.Since(last) < m.janitorEvery && !(low && time.Since(last) > 5*time.Minute) {
			continue
		}
		pctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		sum, err := m.Cleanup(pctx, w)
		cancel()
		switch {
		case err != nil:
			m.logf("node: janitor on %s: %v", w.Name, err)
		case sum != nothingFreed:
			m.logf("node: janitor on %s: %s", w.Name, sum)
		}
	}
}

const nothingFreed = "Nothing to free; the registry mirror runs"

// Cleanup implements api.Workers.
func (m *Manager) Cleanup(ctx context.Context, w model.Worker) (string, error) {
	j := m.janitorOf(w.ID)
	j.mu.Lock()
	defer j.mu.Unlock()
	j.last = time.Now()
	set := m.settings()
	var (
		freed      int64
		images     int
		volumes    int
		emptied    bool
		problems   []string
		ourImages  = []string{set.RunnerImage, set.DindImage, set.MirrorImage}
		currentIDs = map[string]bool{}
	)
	fail := func(what string, err error) { problems = append(problems, what+": "+err.Error()) }

	// GitHub refuses runners that are too old, so the image is pulled again
	// once a day.
	if time.Since(j.refreshed) > refreshEvery {
		ok := true
		for _, img := range ourImages {
			if _, err := m.pull(ctx, w, img); err != nil {
				ok = false
				fail("pulling "+img, err)
			}
		}
		if ok {
			j.refreshed = time.Now()
		}
	}
	out, err := m.sh(ctx, w, "for i in "+q(set.RunnerImage)+" "+q(set.DindImage)+" "+q(set.MirrorImage)+
		"; do docker image inspect -f '{{.Id}}' \"$i\" 2>/dev/null || :; done", "")
	if err != nil {
		return "", err
	}
	for _, id := range strings.Fields(out) {
		currentIDs[id] = true
	}

	// Superseded versions of our images. rmi without force leaves an image
	// alone while a container uses it or another tag points to it.
	for _, id := range m.knownImages(w.ID) {
		if currentIDs[id] {
			continue
		}
		out, err := m.sh(ctx, w, "i="+q(id)+"\ns=$(docker image inspect -f '{{.Size}}' \"$i\" 2>/dev/null) || { echo gone; exit 0; }\n"+
			"if e=$(docker rmi \"$i\" 2>&1 >/dev/null); then echo \"removed $s\"; else echo \"$e\" | tail -1; fi", "")
		out = strings.TrimSpace(out)
		switch {
		case err != nil:
			fail("removing an old image", err)
		case out == "gone":
			m.forgetImage(w.ID, id)
		case strings.HasPrefix(out, "removed "):
			n, _ := strconv.ParseInt(strings.TrimPrefix(out, "removed "), 10, 64)
			freed += n
			images++
			m.forgetImage(w.ID, id)
		case strings.Contains(out, "must be forced") || strings.Contains(out, "multiple repositories"):
			m.forgetImage(w.ID, id) // someone else tagged it: not only ours
		}
	}

	// Runner tools of runner images that are no longer current. A volume in
	// use by a running runner stays until the next pass.
	out, err = m.sh(ctx, w, `set -e
img=`+q(set.RunnerImage)+`
`+externalsScript+fillExternals+`
for v in $(docker volume ls -q --filter label=`+labelRole+`=externals); do
  if [ "$v" != "$ext" ] && docker volume rm "$v" >/dev/null 2>&1; then echo "removed $v"; fi
done`, "")
	if err != nil {
		fail("runner tools", err)
	}
	volumes += strings.Count(out, "removed ")

	// The mirror is emptied as a whole when it outgrows its cap: a pull
	// through cache can always be filled again.
	if set.MirrorCapMB > 0 {
		out, err := m.sh(ctx, w, "docker exec "+mirrorName+" du -sm /var/lib/registry 2>/dev/null | cut -f1", "")
		if mb, perr := strconv.Atoi(strings.TrimSpace(out)); err == nil && perr == nil && mb > set.MirrorCapMB {
			if _, err := m.sh(ctx, w, "set -e\ndocker rm -f "+mirrorName+" >/dev/null\ndocker volume rm "+mirrorName+" >/dev/null", ""); err != nil {
				fail("emptying the registry mirror", err)
			} else {
				freed += int64(mb) << 20
				emptied = true
			}
		}
	}
	if _, err := m.sh(ctx, w, "set -e\nmimg="+q(set.MirrorImage)+"\n"+mirrorScript, ""); err != nil {
		fail("starting the registry mirror", err)
	}

	var parts []string
	if images > 0 {
		parts = append(parts, plural(images, "old image"))
	}
	if volumes > 0 {
		parts = append(parts, plural(volumes, "volume"))
	}
	if emptied {
		parts = append(parts, "emptied the registry mirror")
	}
	sum := nothingFreed
	if len(parts) > 0 {
		sum = "Freed " + humanBytes(freed) + ": " + strings.Join(parts, ", ")
	}
	if len(problems) > 0 {
		return sum, errors.New(sum + ". Some steps failed: " + strings.Join(problems, "; "))
	}
	return sum, nil
}

func plural(n int, what string) string {
	if n == 1 {
		return "1 " + what
	}
	return strconv.Itoa(n) + " " + what + "s"
}

func humanBytes(b int64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(b)/(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%d MB", b>>20)
	}
	return fmt.Sprintf("%d KB", b>>10)
}

// --- images CI-Plane pulled, by worker; kept in the store so a restart does
// not forget what may be removed. ---

func imagesKey(workerID int64) string { return "node:images:" + strconv.FormatInt(workerID, 10) }

func (m *Manager) knownImages(workerID int64) []string {
	var ids []string
	_ = m.st.View(func(tx *store.Tx) error {
		if err := tx.GetJSON(imagesKey(workerID), &ids); err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		return nil
	})
	return ids
}

func (m *Manager) rememberImages(workerID int64, ids ...string) {
	m.editImages(workerID, func(have []string) []string {
		for _, id := range ids {
			if strings.HasPrefix(id, "sha256:") && !slices.Contains(have, id) {
				have = append(have, id)
			}
		}
		return have
	})
}

func (m *Manager) forgetImage(workerID int64, id string) {
	m.editImages(workerID, func(have []string) []string {
		return slices.DeleteFunc(have, func(x string) bool { return x == id })
	})
}

func (m *Manager) forgetImages(workerID int64) {
	_ = m.st.Tx(func(tx *store.Tx) error { return tx.Delete(imagesKey(workerID)) })
}

func (m *Manager) editImages(workerID int64, fn func([]string) []string) {
	err := m.st.Tx(func(tx *store.Tx) error {
		var ids []string
		if err := tx.GetJSON(imagesKey(workerID), &ids); err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		return tx.SetJSON(imagesKey(workerID), fn(ids))
	})
	if err != nil {
		m.logf("node: remember images: %v", err)
	}
}
