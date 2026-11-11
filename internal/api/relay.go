package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// validRepoName reports whether s is owner/name as GitHub allows it.
func validRepoName(s string) bool {
	owner, name, ok := strings.Cut(s, "/")
	if !ok || owner == "" || name == "" || strings.Contains(name, "/") || len(s) > 140 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_', c == '.', c == '/':
		default:
			return false
		}
	}
	return true
}

// checkRelay adds the errors of the failover's fields that need no store.
func checkRelay(set model.Settings, errs map[string]string) {
	if set.RelayRepo != "" && !validRepoName(set.RelayRepo) {
		errs["relayRepo"] = "Enter the repository as owner/name, like acme/ci-plane-relay."
	}
	if !set.RelayEnabled {
		return
	}
	if set.RelayRepo == "" {
		errs["relayRepo"] = "Choose the private repository that runs the relay workflow."
	}
	if _, ok := set.SizeByName(set.RelayMaxSize); !ok {
		errs["relayMaxSize"] = "Choose one of the sizes."
	}
}

// checkRelayRepo checks that CI-Plane sees the relay repository and that it
// is private, and that it does not change while runners run through it. It
// returns "" if it is fine.
func checkRelayRepo(tx *store.Tx, set model.Settings) (string, error) {
	cur, err := tx.Settings()
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(cur.RelayRepo, set.RelayRepo) && cur.RelayRepo != "" {
		runners, err := tx.ActiveRunners()
		if err != nil {
			return "", err
		}
		n := 0
		for _, x := range runners {
			if x.WorkerID == model.RelayWorkerID {
				n++
			}
		}
		if n > 0 {
			return fmt.Sprintf("%d runners run through %s right now. Switch the failover off, wait until they are done, then change the repository.", n, cur.RelayRepo), nil
		}
	}
	if !set.RelayEnabled || set.RelayRepo == "" || !validRepoName(set.RelayRepo) {
		return "", nil
	}
	repos, err := tx.Repos(0)
	if err != nil {
		return "", err
	}
	for _, p := range repos {
		if strings.EqualFold(p.FullName, set.RelayRepo) {
			if !p.Private {
				return "This repository is public. Use a private one: its runs show the names of your runners.", nil
			}
			return "", nil
		}
	}
	owner, _, _ := strings.Cut(set.RelayRepo, "/")
	return fmt.Sprintf("CI-Plane does not see this repository. Install the GitHub App of %s on it, then try again.", owner), nil
}

// relayRepoView is a repository that may serve as relay repository.
type relayRepoView struct {
	FullName string `json:"fullName"`
	Private  bool   `json:"private"`
}

// relayState is what the settings show about the failover.
func (s *Server) relayState(w http.ResponseWriter, r *http.Request) {
	var resp struct {
		Available bool            `json:"available"`
		Workflow  string          `json:"workflow"`
		PublicURL string          `json:"publicUrl"`
		Off       *model.RelayOff `json:"off"`
		Active    int             `json:"active"` // runners on GitHub-hosted machines right now
		Repos     []relayRepoView `json:"repos"`
	}
	resp.Available = s.d.Relay != nil
	if s.d.Relay != nil {
		resp.Workflow = s.d.Relay.Workflow()
	}
	resp.PublicURL = s.publicURL()
	resp.Repos = []relayRepoView{}
	err := s.d.Store.View(func(tx *store.Tx) error {
		var off model.RelayOff
		switch err := tx.GetJSON(model.RelayOffKey, &off); {
		case err == nil:
			resp.Off = &off
		case !errors.Is(err, store.ErrNotFound):
			return err
		}
		runners, err := tx.ActiveRunners()
		if err != nil {
			return err
		}
		for _, x := range runners {
			if x.WorkerID == model.RelayWorkerID {
				resp.Active++
			}
		}
		repos, err := tx.Repos(0)
		if err != nil {
			return err
		}
		for _, p := range repos {
			resp.Repos = append(resp.Repos, relayRepoView{FullName: p.FullName, Private: p.Private})
		}
		return nil
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	sort.Slice(resp.Repos, func(a, b int) bool {
		return strings.ToLower(resp.Repos[a].FullName) < strings.ToLower(resp.Repos[b].FullName)
	})
	writeJSON(w, http.StatusOK, resp)
}

// relayCheck asks GitHub whether the failover would work.
func (s *Server) relayCheck(w http.ResponseWriter, r *http.Request) {
	if s.d.Relay == nil {
		writeError(w, http.StatusServiceUnavailable, "The failover to GitHub-hosted runners is not available in this mode.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	problems := s.d.Relay.Check(ctx)
	if problems == nil {
		problems = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"problems": problems})
}
