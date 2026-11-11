package api

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// checkRelay adds the errors of the failover's fields.
func checkRelay(set model.Settings, errs map[string]string) {
	if _, ok := set.SizeByName(set.RelayMaxSize); !ok && set.RelayEnabled {
		errs["relayMaxSize"] = "Choose one of the sizes."
	}
}

// relayState is what the interface shows about the failover.
func (s *Server) relayState(w http.ResponseWriter, r *http.Request) {
	var resp struct {
		Available bool           `json:"available"`
		Workflow  string         `json:"workflow"`
		PublicURL string         `json:"publicUrl"`
		Active    int            `json:"active"`  // runners on GitHub-hosted machines right now
		PerRepo   map[string]int `json:"perRepo"` // the same, by repository id
		Repos     []model.Repo   `json:"repos"`   // with the failover on, or switched off by itself
	}
	resp.Available = s.d.Relay != nil
	if s.d.Relay != nil {
		resp.Workflow = s.d.Relay.Workflow()
	}
	resp.PublicURL = s.publicURL()
	resp.PerRepo = map[string]int{}
	resp.Repos = []model.Repo{}
	err := s.d.Store.View(func(tx *store.Tx) error {
		runners, err := tx.ActiveRunners()
		if err != nil {
			return err
		}
		for _, x := range runners {
			if x.WorkerID == model.RelayWorkerID {
				resp.Active++
				resp.PerRepo[strconv.FormatInt(x.RepoID, 10)]++
			}
		}
		repos, err := tx.Repos(0)
		if err != nil {
			return err
		}
		for _, p := range repos {
			if p.Relay || p.RelayOff != "" {
				resp.Repos = append(resp.Repos, p)
			}
		}
		return nil
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// relayCheck asks GitHub whether the failover of a repository would work.
func (s *Server) relayCheck(w http.ResponseWriter, r *http.Request) {
	if s.d.Relay == nil {
		writeError(w, http.StatusServiceUnavailable, "The failover to GitHub-hosted runners is not available in this mode.")
		return
	}
	var req struct {
		Repo int64 `json:"repo"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := s.d.Store.View(func(tx *store.Tx) error { _, err := tx.Repo(req.Repo); return err }); err != nil {
		writeError(w, http.StatusNotFound, "CI-Plane does not know this repository.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.d.Relay.Check(ctx, req.Repo))
}
