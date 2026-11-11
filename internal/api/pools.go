package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// machineRe is a runs-on label as providers name their machines.
var machineRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

// poolPreset is what a new pool of a kind starts with.
type poolPreset struct {
	Kind     string `json:"kind"`
	Label    string `json:"label"`
	Name     string `json:"name"`     // suggested name of the pool
	Standard string `json:"standard"` // machine for standard jobs
	Large    string `json:"large"`    // machine for large jobs; empty = none
	Hint     string `json:"hint"`     // what the person has to know
	Docs     string `json:"docs"`     // where the machines are listed
}

var poolPresets = []poolPreset{
	{Kind: model.PoolGitHub, Label: "GitHub-hosted runners", Name: "GitHub", Standard: "ubuntu-latest",
		Hint: "Uses the GitHub Actions minutes of the repository's owner. For large jobs, enter the label of a larger runner of your plan, if you have one.",
		Docs: "https://docs.github.com/en/actions/reference/runners/github-hosted-runners"},
	{Kind: model.PoolBlacksmith, Label: "Blacksmith", Name: "Blacksmith", Standard: "blacksmith-4vcpu-ubuntu-2404", Large: "blacksmith-8vcpu-ubuntu-2404",
		Hint: "Blacksmith works in organisations only: its GitHub App must be installed on the organisation of the repository.",
		Docs: "https://docs.blacksmith.sh/blacksmith-runners/overview"},
	{Kind: model.PoolCustom, Label: "Another provider", Name: "",
		Hint: "Any provider whose machines run GitHub Actions jobs by a runs-on label, set up for the repository."},
}

// poolView is a pool with what the interface shows next to it.
type poolView struct {
	model.Pool
	Active  int   `json:"active"`  // runners on it right now
	UsedMin int64 `json:"usedMin"` // runner minutes used this month, running ones included
	Paused  bool  `json:"paused"`  // pausing after failed starts
	Next    int   `json:"nextPauseSec"`
}

func poolName(tx *store.Tx, workerID int64) string {
	if p, err := tx.Pool(-workerID); err == nil {
		return p.Name
	}
	return "a pool that was removed"
}

func (s *Server) poolViews(tx *store.Tx, now int64) ([]poolView, error) {
	pools, err := tx.Pools()
	if err != nil {
		return nil, err
	}
	runners, err := tx.ActiveRunners()
	if err != nil {
		return nil, err
	}
	month := time.UnixMilli(now).UTC().Format("2006-01")
	out := make([]poolView, 0, len(pools))
	for _, p := range pools {
		v := poolView{Pool: p, Paused: p.PausedUntil > now, Next: model.PoolPauseSec(p.Fails + 1)}
		used := int64(0)
		if p.Month == month {
			used = p.UsedSec
		}
		for _, x := range runners {
			if x.WorkerID != p.WorkerID() {
				continue
			}
			v.Active++
			if x.OnlineAt > 0 && now > x.OnlineAt {
				used += (now - x.OnlineAt) / 1000
			}
		}
		v.UsedMin = (used + 59) / 60
		out = append(out, v)
	}
	return out, nil
}

type relayRepoView struct {
	FullName string `json:"fullName"`
	Private  bool   `json:"private"`
}

func (s *Server) listPools(w http.ResponseWriter, r *http.Request) {
	var resp struct {
		Available bool            `json:"available"`
		Workflow  string          `json:"workflow"`  // the file to add to the repository of a pool
		PublicURL string          `json:"publicUrl"` // empty: runs could not reach CI-Plane
		Presets   []poolPreset    `json:"presets"`
		Repos     []relayRepoView `json:"repos"` // repositories CI-Plane sees
		Pools     []poolView      `json:"pools"`
	}
	resp.Available = s.d.Relay != nil
	if s.d.Relay != nil {
		resp.Workflow = s.d.Relay.Workflow()
	}
	resp.PublicURL, resp.Presets, resp.Repos = s.publicURL(), poolPresets, []relayRepoView{}
	err := s.d.Store.View(func(tx *store.Tx) error {
		var err error
		if resp.Pools, err = s.poolViews(tx, time.Now().UnixMilli()); err != nil {
			return err
		}
		repos, err := tx.Repos(0)
		for _, p := range repos {
			resp.Repos = append(resp.Repos, relayRepoView{FullName: p.FullName, Private: p.Private})
		}
		return err
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// poolReq is what the interface sends to add or change a pool; a field
// that is left out stays as it is.
type poolReq struct {
	Name      *string `json:"name"`
	Kind      *string `json:"kind"`
	Repo      *string `json:"repo"`
	Tier      *int    `json:"tier"`
	Enabled   *bool   `json:"enabled"`
	AfterSec  *int    `json:"afterSec"`
	Max       *int    `json:"max"`
	Standard  *string `json:"standard"`
	Large     *string `json:"large"`
	BudgetMin *int    `json:"budgetMin"`
}

func (q poolReq) apply(p *model.Pool) {
	str := func(dst *string, src *string) {
		if src != nil {
			*dst = strings.TrimSpace(*src)
		}
	}
	num := func(dst *int, src *int) {
		if src != nil {
			*dst = *src
		}
	}
	str(&p.Name, q.Name)
	str(&p.Kind, q.Kind)
	str(&p.Repo, q.Repo)
	str(&p.Standard, q.Standard)
	str(&p.Large, q.Large)
	num(&p.Tier, q.Tier)
	num(&p.AfterSec, q.AfterSec)
	num(&p.Max, q.Max)
	num(&p.BudgetMin, q.BudgetMin)
	if q.Enabled != nil {
		p.Enabled = *q.Enabled
	}
	p.Repo = strings.Trim(p.Repo, "/")
}

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

// checkPool returns an error per field of a pool, keyed by its JSON name.
func checkPool(tx *store.Tx, p model.Pool) (map[string]string, error) {
	errs := map[string]string{}
	pools, err := tx.Pools()
	if err != nil {
		return nil, err
	}
	workers, err := tx.Workers()
	if err != nil {
		return nil, err
	}
	switch {
	case p.Name == "" || len(p.Name) > 40:
		errs["name"] = "Give the pool a name of up to 40 characters, like GitHub."
	default:
		for _, o := range pools {
			if o.ID != p.ID && strings.EqualFold(o.Name, p.Name) {
				errs["name"] = "Another pool has this name."
			}
		}
		for _, o := range workers {
			if strings.EqualFold(o.Name, p.Name) {
				errs["name"] = "A worker has this name."
			}
		}
	}
	if !model.ValidPoolKind(p.Kind) {
		errs["kind"] = "Choose who runs the machines."
	}
	switch {
	case p.Repo == "":
		errs["repo"] = "Choose the private repository that runs the relay workflow."
	case !validRepoName(p.Repo):
		errs["repo"] = "Enter the repository as owner/name, like acme/ci-plane-relay."
	default:
		repos, err := tx.Repos(0)
		if err != nil {
			return nil, err
		}
		owner, _, _ := strings.Cut(p.Repo, "/")
		errs["repo"] = fmt.Sprintf("CI-Plane does not see this repository. Install the GitHub App of %s on it, then try again.", owner)
		for _, o := range repos {
			if !strings.EqualFold(o.FullName, p.Repo) {
				continue
			}
			delete(errs, "repo")
			if !o.Private {
				errs["repo"] = "This repository is public. Use a private one: its runs show the names of your runners."
			}
		}
	}
	if p.Tier < 1 || p.Tier > maxTier {
		errs["tier"] = fmt.Sprintf("The tier is a number from 1 to %d; 1 is used first.", maxTier)
	}
	if p.AfterSec < 0 || p.AfterSec > 24*3600 {
		errs["afterSec"] = "Enter a waiting time from 0 minutes to 24 hours; 0 means at once."
	}
	if p.Max < 1 || p.Max > 100 {
		errs["max"] = "Enter a number from 1 to 100 runners."
	}
	set, err := tx.Settings()
	if err != nil {
		return nil, err
	}
	// A label CI-Plane itself answers to would send the run of the relay
	// workflow back to CI-Plane.
	own := func(label string) bool {
		l := strings.ToLower(label)
		_, size := set.SizeByName(l)
		return size || l == "self-hosted" || l == strings.ToLower(set.BaseLabel)
	}
	switch {
	case !machineRe.MatchString(p.Standard):
		errs["standard"] = "Enter the runs-on label of the machine, like ubuntu-latest."
	case own(p.Standard):
		errs["standard"] = "This is a label of CI-Plane's own runners. Enter the label of a machine of the provider, like ubuntu-latest."
	}
	switch {
	case p.Large != "" && !machineRe.MatchString(p.Large):
		errs["large"] = "Enter the runs-on label of the machine, or leave it empty if large jobs should not go here."
	case p.Large != "" && own(p.Large):
		errs["large"] = "This is a label of CI-Plane's own runners. Enter the label of a machine of the provider, or leave it empty."
	}
	if p.BudgetMin < 0 || p.BudgetMin > 10_000_000 {
		errs["budgetMin"] = "Enter the minutes per month, or 0 for no limit."
	}
	return errs, nil
}

var errPoolFields = errors.New("fields need attention")

func (s *Server) addPool(w http.ResponseWriter, r *http.Request) {
	var req poolReq
	if !decode(w, r, &req) {
		return
	}
	s.storePool(w, 0, req)
}

func (s *Server) editPool(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var req poolReq
	if !decode(w, r, &req) {
		return
	}
	s.storePool(w, id, req)
}

// storePool checks and stores a new pool (id 0) or a change to one. A
// change made by the person is a reason to try a pausing pool again.
func (s *Server) storePool(w http.ResponseWriter, id int64, req poolReq) {
	var errs map[string]string
	var p model.Pool
	err := s.d.Store.Tx(func(tx *store.Tx) error {
		var err error
		if id == 0 {
			p = model.Pool{Kind: model.PoolGitHub, Tier: maxTier, Enabled: true, AfterSec: 180, Max: 5}
		} else if p, err = tx.Pool(id); err != nil {
			return err
		}
		tier := p.Tier
		req.apply(&p)
		if errs, err = checkPool(tx, p); err != nil {
			return err
		}
		if len(errs) > 0 {
			return errPoolFields
		}
		if id == 0 || p.Tier != tier {
			// The last one of its tier.
			pools, err := tx.Pools()
			if err != nil {
				return err
			}
			p.Position = 0
			for _, o := range pools {
				if o.ID != p.ID && o.Tier == p.Tier && o.Position >= p.Position {
					p.Position = o.Position + 1
				}
			}
		}
		if id == 0 {
			p, err = tx.AddPool(p)
			return err
		}
		p.Fails, p.PausedUntil, p.PauseReason = 0, 0, ""
		return tx.SavePool(p)
	})
	switch {
	case errors.Is(err, errPoolFields):
		writeJSON(w, http.StatusBadRequest, apiError{Error: "The pool was not saved: " + firstOf(errs), Fields: errs})
		return
	case err != nil:
		s.fail(w, err)
		return
	}
	s.changedWorkers()
	if s.d.Engine != nil {
		s.d.Engine.Kick()
	}
	writeJSON(w, http.StatusOK, map[string]any{"pool": p})
}

func (s *Server) removePool(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	active := 0
	err := s.d.Store.Tx(func(tx *store.Tx) error {
		p, err := tx.Pool(id)
		if err != nil {
			return err
		}
		runners, err := tx.ActiveRunners()
		if err != nil {
			return err
		}
		for _, x := range runners {
			if x.WorkerID == p.WorkerID() {
				active++
			}
		}
		if active > 0 {
			return nil
		}
		return tx.DeletePool(id)
	})
	switch {
	case err != nil:
		s.fail(w, err)
		return
	case active > 0:
		on := fmt.Sprintf("%d runners are", active)
		if active == 1 {
			on = "1 runner is"
		}
		writeError(w, http.StatusConflict, on+" on this pool right now. Switch it off, wait until they are done, then remove it.")
		return
	}
	s.changedWorkers()
	writeJSON(w, http.StatusOK, map[string]any{})
}

// checkPool asks GitHub whether a pool would work.
func (s *Server) checkPool(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if s.d.Relay == nil {
		writeError(w, http.StatusServiceUnavailable, "Pools of other providers are not available in this mode.")
		return
	}
	var p model.Pool
	if err := s.d.Store.View(func(tx *store.Tx) error {
		var err error
		p, err = tx.Pool(id)
		return err
	}); err != nil {
		s.fail(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.d.Relay.Check(ctx, p.Repo))
}

// resumePool ends the pause of a pool, so that it is tried at once.
func (s *Server) resumePool(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var p model.Pool
	err := s.d.Store.Tx(func(tx *store.Tx) error {
		var err error
		if p, err = tx.Pool(id); err != nil {
			return err
		}
		p.Fails, p.PausedUntil, p.PauseReason = 0, 0, ""
		return tx.SavePool(p)
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	s.changedWorkers()
	if s.d.Engine != nil {
		s.d.Engine.Kick()
	}
	writeJSON(w, http.StatusOK, map[string]any{"pool": p})
}
