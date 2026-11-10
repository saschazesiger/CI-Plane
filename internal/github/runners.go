package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/saschazesiger/CI-Plane/internal/engine"
)

// defaultRunnerGroup is the group every organisation has; runners of
// CI-Plane join it, which by default serves the organisation's private
// repositories.
const defaultRunnerGroup = 1

// runnersPath is where the runners of a target live.
func runnersPath(t engine.Target) (string, error) {
	if t.Repo == "" {
		if t.Owner == "" {
			return "", errors.New("the runner has neither an organisation nor a repository")
		}
		return "/orgs/" + url.PathEscape(t.Owner) + "/actions/runners", nil
	}
	p, err := repoPath(t.Repo)
	if err != nil {
		return "", err
	}
	return p + "/actions/runners", nil
}

// CreateRunner implements engine.Forge.
func (s *Service) CreateRunner(ctx context.Context, t engine.Target, name string, labels []string) (engine.Registration, error) {
	base, err := runnersPath(t)
	if err != nil {
		return engine.Registration{}, err
	}
	var out struct {
		Runner struct {
			ID int64 `json:"id"`
		} `json:"runner"`
		EncodedJITConfig string `json:"encoded_jit_config"`
	}
	_, err = s.getJSON(ctx, call{
		method: http.MethodPost, path: base + "/generate-jitconfig", auth: authInstallation, account: t.AccountID,
		body: map[string]any{"name": name, "runner_group_id": defaultRunnerGroup, "labels": labels, "work_folder": "_work"},
	}, &out)
	if err != nil {
		// GitHub answers 409 when the name is taken; some versions of the
		// API have used 422 with the same message.
		var ae *apiError
		if errors.As(err, &ae) && (ae.Status == http.StatusConflict ||
			(ae.Status == http.StatusUnprocessableEntity && strings.Contains(strings.ToLower(ae.Message), "already exists"))) {
			return engine.Registration{}, engine.ErrRunnerExists
		}
		s.noteAPI(t.AccountID, err)
		return engine.Registration{}, err
	}
	s.noteAPI(t.AccountID, nil)
	if out.Runner.ID == 0 || out.EncodedJITConfig == "" {
		return engine.Registration{}, errors.New("GitHub registered the runner but returned no configuration for it; it will be tried again")
	}
	return engine.Registration{ID: out.Runner.ID, JITConfig: out.EncodedJITConfig}, nil
}

// DeleteRunner implements engine.Forge.
func (s *Service) DeleteRunner(ctx context.Context, t engine.Target, id int64) error {
	base, err := runnersPath(t)
	if err != nil {
		return err
	}
	_, err = s.do(ctx, call{method: http.MethodDelete, path: base + "/" + strconv.FormatInt(id, 10), auth: authInstallation, account: t.AccountID})
	var ae *apiError
	switch {
	case err == nil:
	case errors.As(err, &ae) && ae.Status == http.StatusNotFound:
		err = nil // already gone
	case errors.As(err, &ae) && ae.Status == http.StatusUnprocessableEntity && strings.Contains(strings.ToLower(ae.Message), "running a job"):
		// "Bad request - Runner \"name\" is still running a job"
		return engine.ErrRunnerBusy
	}
	s.noteAPI(t.AccountID, err)
	return err
}

// ListRunners implements engine.Forge.
func (s *Service) ListRunners(ctx context.Context, t engine.Target) ([]engine.ForgeRunner, error) {
	base, err := runnersPath(t)
	if err != nil {
		return nil, err
	}
	out := []engine.ForgeRunner{}
	for page := 1; ; page++ {
		var res struct {
			TotalCount int `json:"total_count"`
			Runners    []struct {
				ID     int64  `json:"id"`
				Name   string `json:"name"`
				Status string `json:"status"`
				Busy   bool   `json:"busy"`
			} `json:"runners"`
		}
		_, err := s.getJSON(ctx, call{
			method: http.MethodGet, path: fmt.Sprintf("%s?per_page=100&page=%d", base, page),
			auth: authInstallation, account: t.AccountID,
		}, &res)
		s.noteAPI(t.AccountID, err)
		if err != nil {
			return nil, err
		}
		for _, r := range res.Runners {
			out = append(out, engine.ForgeRunner{ID: r.ID, Name: r.Name, Online: r.Status == "online", Busy: r.Busy})
		}
		if len(res.Runners) < 100 || len(out) >= res.TotalCount || page >= 100 {
			return out, nil
		}
	}
}
