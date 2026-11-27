package api

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
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
	Active   int     `json:"active"`   // runners on it right now
	UsedMin  int64   `json:"usedMin"`  // runner minutes used this month: CI-Plane's count or GitHub's, whichever is higher
	OwnMin   int64   `json:"ownMin"`   // CI-Plane's own count, running runners included
	SpentUSD float64 `json:"spentUsd"` // what it cost this month as far as known; 0 without GitHub's billing
	// BudgetStop says why its budget lets it take no jobs now; "" if it does.
	// BudgetWaits: because GitHub's billing, on which it rests, has not
	// been read for a while.
	BudgetStop  string `json:"budgetStop"`
	BudgetWaits bool   `json:"budgetWaits"`
	Paused      bool   `json:"paused"` // pausing after failed starts
	Next        int    `json:"nextPauseSec"`
	// OwnerType is that of the account that starts its runs: "User" or
	// "Organization"; "" if unknown. HasUsageToken says whether a token
	// that reads the billing of a personal account is stored for it.
	OwnerType     string `json:"ownerType"`
	HasUsageToken bool   `json:"hasUsageToken"`
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
		v.OwnMin = (used + 59) / 60
		v.UsedMin = int64(math.Ceil(engine.PoolMinutes(p, runners, now) - 1e-9))
		v.SpentUSD = math.Round(engine.PoolSpent(p, runners, now)*100) / 100
		v.BudgetStop = engine.PoolBudget(p, runners, now)
		v.BudgetWaits = engine.UsageMissing(p, now)
		if a, ok := poolAccount(tx, p.AccountID); ok {
			v.OwnerType = a.OwnerType
		}
		v.HasUsageToken = s.hasUsageToken(tx, p.AccountID)
		if v.Usage.Machines == nil {
			v.Usage.Machines = []model.MachineUsage{}
		}
		if v.Usage.Budgets == nil {
			v.Usage.Budgets = []model.GitHubBudget{}
		}
		out = append(out, v)
	}
	return out, nil
}

// poolAccount is the account whose app starts the runs of a pool: a runner
// account or one of the repository integration.
func poolAccount(tx *store.Tx, id int64) (model.Account, bool) {
	if id == 0 {
		return model.Account{}, false
	}
	a, err := tx.RunnerAccount(id)
	if err != nil {
		if a, err = tx.Account(id); err != nil {
			return model.Account{}, false
		}
	}
	return a, true
}

func (s *Server) hasUsageToken(tx *store.Tx, accountID int64) bool {
	if s.d.Box == nil || accountID == 0 {
		return false
	}
	b, err := s.d.Box.Get(tx, UsageTokenName(accountID))
	return err == nil && len(b) > 0
}

// relayRepoView is a repository a pool can use, with the app that would
// start the runs in it.
type relayRepoView struct {
	AccountID int64  `json:"accountId"`
	Owner     string `json:"owner"`   // of the app
	Runners   bool   `json:"runners"` // the app is a runner account
	FullName  string `json:"fullName"`
	Private   bool   `json:"private"`
	// OwnerType of the app's account, "User" or "Organization", and whether
	// a token that reads the billing of the personal account is stored.
	OwnerType     string `json:"ownerType"`
	HasUsageToken bool   `json:"hasUsageToken"`
}

// relayRepos are the repositories pools can use: those of the runner
// accounts first, then those of the repository integration.
func relayRepos(tx *store.Tx) ([]relayRepoView, error) {
	out := []relayRepoView{}
	runnerAccs, err := tx.RunnerAccounts()
	if err != nil {
		return nil, err
	}
	for _, a := range runnerAccs {
		repos, err := tx.RunnerRepos(a.ID)
		if err != nil {
			return nil, err
		}
		for _, p := range repos {
			out = append(out, relayRepoView{AccountID: a.ID, Owner: a.Owner, Runners: true, FullName: p.FullName, Private: p.Private})
		}
	}
	accs, err := tx.Accounts()
	if err != nil {
		return nil, err
	}
	owner := map[int64]string{}
	for _, a := range accs {
		owner[a.ID] = a.Owner
	}
	repos, err := tx.Repos(0)
	if err != nil {
		return nil, err
	}
	for _, p := range repos {
		if o, ok := owner[p.AccountID]; ok {
			out = append(out, relayRepoView{AccountID: p.AccountID, Owner: o, FullName: p.FullName, Private: p.Private})
		}
	}
	return out, nil
}

func (s *Server) listPools(w http.ResponseWriter, r *http.Request) {
	var resp struct {
		Available bool            `json:"available"`
		Workflow  string          `json:"workflow"`  // the file to add to the repository of a pool
		PublicURL string          `json:"publicUrl"` // empty: runs could not reach CI-Plane
		Presets   []poolPreset    `json:"presets"`
		Repos     []relayRepoView `json:"repos"` // repositories pools can use
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
		if resp.Repos, err = relayRepos(tx); err != nil {
			return err
		}
		for i, o := range resp.Repos {
			if a, ok := poolAccount(tx, o.AccountID); ok {
				resp.Repos[i].OwnerType = a.OwnerType
			}
			resp.Repos[i].HasUsageToken = s.hasUsageToken(tx, o.AccountID)
		}
		return nil
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
	Name       *string `json:"name"`
	Kind       *string `json:"kind"`
	AccountID  *int64  `json:"accountId"`
	Repo       *string `json:"repo"`
	Tier       *int    `json:"tier"`
	Enabled    *bool   `json:"enabled"`
	AfterSec   *int    `json:"afterSec"`
	Max        *int    `json:"max"`
	Standard   *string `json:"standard"`
	Large      *string `json:"large"`
	BudgetKind *string `json:"budgetKind"`
	BudgetMin  *int    `json:"budgetMin"`
	BudgetUSD  *int    `json:"budgetUsd"`
	// UsageToken, if not empty, is a new token of a person that reads the
	// billing of the personal account the pool's runs are billed to.
	UsageToken *string `json:"usageToken"`
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
	str(&p.BudgetKind, q.BudgetKind)
	num(&p.BudgetMin, q.BudgetMin)
	num(&p.BudgetUSD, q.BudgetUSD)
	if q.Enabled != nil {
		p.Enabled = *q.Enabled
	}
	if q.AccountID != nil {
		p.AccountID = *q.AccountID
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
		repos, err := relayRepos(tx)
		if err != nil {
			return nil, err
		}
		var app string
		for _, o := range repos {
			if o.AccountID == p.AccountID {
				app = o.Owner
			}
		}
		owner, _, _ := strings.Cut(p.Repo, "/")
		switch {
		case p.AccountID == 0:
			errs["repo"] = fmt.Sprintf("CI-Plane does not see this repository. Install the GitHub App of %s on it, then try again.", owner)
		case app == "":
			errs["repo"] = "Connect the GitHub account that owns the repository under Accounts, and choose the repository for its app."
		default:
			errs["repo"] = fmt.Sprintf("The app of %s does not see this repository. Choose it for the app with \"Choose repositories on GitHub\", then try again.", app)
		}
		for _, o := range repos {
			// A pool of an earlier version has no account: any app of the
			// repository integration that sees the repository starts it.
			if !strings.EqualFold(o.FullName, p.Repo) || (o.AccountID != p.AccountID && (p.AccountID != 0 || o.Runners)) {
				continue
			}
			delete(errs, "repo")
			if !o.Private {
				errs["repo"] = "This repository is public. Use a private one: its runs show the names of your runners."
			}
			break
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
	switch p.Budget() {
	case model.BudgetMinutes:
		if p.BudgetMin < 0 || p.BudgetMin > 10_000_000 {
			errs["budgetMin"] = "Enter the minutes per month, or 0 for no limit."
		}
	case model.BudgetDollars:
		if p.BudgetUSD < 1 || p.BudgetUSD > 1_000_000 {
			errs["budgetUsd"] = "Enter the US dollars per month, a whole number from 1 to 1,000,000."
		}
	}
	a, known := poolAccount(tx, p.AccountID)
	switch {
	case !model.ValidBudgetKind(p.Budget()):
		errs["budgetKind"] = "Choose what limits the pool each month."
	case !p.UsesBilling():
	case p.Kind != model.PoolGitHub:
		errs["budgetKind"] = "Only GitHub-hosted runners have their usage on GitHub. Limit this pool by minutes."
	case !known:
		if errs["repo"] == "" {
			errs["repo"] = "Choose the repository again, with the account whose app starts its runs: CI-Plane reads the usage with that app."
		}
	case p.Budget() == model.BudgetGitHub && !a.IsOrg():
		errs["budgetKind"] = "GitHub has no way to read the budgets of a personal account. Choose a budget in dollars, or included minutes only."
	}
	return errs, nil
}

// minTokenLen and maxTokenLen bound what is taken as a token of GitHub.
const minTokenLen, maxTokenLen = 20, 400

// checkUsageToken says what is wrong with the token of a person that reads
// the billing of a pool's personal account; "" if nothing is.
func (s *Server) checkUsageToken(tx *store.Tx, p model.Pool, token string) string {
	a, known := poolAccount(tx, p.AccountID)
	if !known || a.IsOrg() {
		return "" // the app reads the billing of an organisation
	}
	owner, _, _ := strings.Cut(p.Repo, "/")
	switch {
	case token == "" && !p.UsesBilling():
		// A budget of minutes needs no token; with one, the pool shows
		// GitHub's numbers too.
	case token != "" && (len(token) < minTokenLen || len(token) > maxTokenLen || strings.ContainsAny(token, " \t\r\n")):
		return "This does not look like a token of GitHub. Copy it again from GitHub, like github_pat_..."
	case token != "" && s.d.Box == nil:
		return "This mode cannot keep tokens."
	case token == "" && !s.hasUsageToken(tx, p.AccountID):
		return fmt.Sprintf("Enter a token of %s with the permission Plan: read-only. GitHub lets no app read the billing of a personal account.", owner)
	}
	return ""
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
		tier, before := p.Tier, p
		req.apply(&p)
		if errs, err = checkPool(tx, p); err != nil {
			return err
		}
		token := ""
		if req.UsageToken != nil {
			token = strings.TrimSpace(*req.UsageToken)
		}
		if msg := s.checkUsageToken(tx, p, token); msg != "" && errs["usageToken"] == "" {
			errs["usageToken"] = msg
		}
		if len(errs) > 0 {
			return errPoolFields
		}
		if a, ok := poolAccount(tx, p.AccountID); !ok || a.IsOrg() {
			token = ""
		}
		if token != "" {
			if err := s.d.Box.Put(tx, UsageTokenName(p.AccountID), []byte(token)); err != nil {
				return err
			}
		}
		if token != "" || p.AccountID != before.AccountID || p.Repo != before.Repo || p.Budget() != before.Budget() {
			// What was read belongs to another repository, account or kind
			// of budget: the engine reads it again at once.
			p.Usage = model.PoolUsage{}
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
	c := s.d.Relay.Check(ctx, p.AccountID, p.Repo)
	if p.UsesBilling() && p.Usage.Error != "" {
		c.Problems = append(c.Problems, "CI-Plane cannot read the usage of "+p.Name+" from GitHub, on which its budget rests: "+p.Usage.Error)
	}
	if c.Problems == nil {
		c.Problems = []string{}
	}
	writeJSON(w, http.StatusOK, c)
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
