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

// --- accounts and repositories -----------------------------------------------

type repoView struct {
	model.Repo
	Running int `json:"running"` // jobs assigned or running now
	Queued  int `json:"queued"`
}

type accountView struct {
	model.Account
	Health     AccountHealth `json:"health"`
	InstallURL string        `json:"installUrl"`
	Repos      []repoView    `json:"repos"`
	Running    int           `json:"running"`
}

func (s *Server) listAccounts(w http.ResponseWriter, r *http.Request) {
	sn, err := s.snapshot()
	if err != nil {
		s.fail(w, err)
		return
	}
	running, queued := map[int64]int{}, map[int64]int{}
	accRunning := map[int64]int{}
	for _, j := range sn.open {
		if j.State == model.JobQueued {
			queued[j.RepoID]++
		} else {
			running[j.RepoID]++
			accRunning[j.AccountID]++
		}
	}
	out := make([]accountView, 0, len(sn.accounts))
	for _, a := range sn.accounts {
		v := accountView{Account: a, Repos: []repoView{}, Running: accRunning[a.ID], Health: AccountHealth{RateRemaining: -1}}
		if s.d.GitHub != nil {
			v.Health = s.d.GitHub.Health(a.ID)
			v.InstallURL = s.d.GitHub.InstallURL(a)
		}
		for _, p := range sn.repos {
			if p.AccountID == a.ID {
				v.Repos = append(v.Repos, repoView{Repo: p, Running: running[p.ID], Queued: queued[p.ID]})
			}
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": out, "publicUrl": s.publicURL()})
}

type limitReq struct {
	Enabled     *bool `json:"enabled"`
	MaxParallel *int  `json:"maxParallel"`
}

func (l limitReq) check() map[string]string {
	if l.MaxParallel != nil && (*l.MaxParallel < 0 || *l.MaxParallel > 1000) {
		return map[string]string{"maxParallel": "Enter a number from 0 to 1000; 0 means no limit."}
	}
	return nil
}

func (s *Server) editAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var req limitReq
	if !decode(w, r, &req) {
		return
	}
	if errs := req.check(); errs != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: firstOf(errs), Fields: errs})
		return
	}
	var a model.Account
	err := s.d.Store.Tx(func(tx *store.Tx) error {
		var err error
		if a, err = tx.Account(id); err != nil {
			return err
		}
		if req.Enabled != nil {
			a.Enabled = *req.Enabled
		}
		if req.MaxParallel != nil {
			a.MaxParallel = *req.MaxParallel
		}
		return tx.SaveAccount(a)
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	s.changedWorkers()
	writeJSON(w, http.StatusOK, map[string]any{"account": a})
}

func (s *Server) editRepo(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var req limitReq
	if !decode(w, r, &req) {
		return
	}
	if errs := req.check(); errs != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: firstOf(errs), Fields: errs})
		return
	}
	var p model.Repo
	err := s.d.Store.Tx(func(tx *store.Tx) error {
		var err error
		if p, err = tx.Repo(id); err != nil {
			return err
		}
		if req.Enabled != nil {
			p.Enabled = *req.Enabled
		}
		if req.MaxParallel != nil {
			p.MaxParallel = *req.MaxParallel
		}
		return tx.SaveRepo(p)
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	s.changedWorkers()
	writeJSON(w, http.StatusOK, map[string]any{"repo": p})
}

func (s *Server) removeRepo(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var p model.Repo
	err := s.d.Store.Tx(func(tx *store.Tx) error {
		var err error
		if p, err = tx.Repo(id); err != nil {
			return err
		}
		return tx.DeleteRepo(id)
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	s.changedWorkers()
	writeJSON(w, http.StatusOK, map[string]string{"message": p.FullName + " was removed. It comes back with the next sync while the app is installed on it; remove it from the installation on GitHub to keep it away."})
}

func (s *Server) removeAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	settingsURL, err := s.d.GitHub.Remove(ctx, id)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, ErrInUse) {
			status = http.StatusConflict
		}
		msg := err.Error()
		msg = strings.ToUpper(msg[:1]) + msg[1:]
		if !strings.HasSuffix(msg, ".") {
			msg += "."
		}
		writeJSON(w, status, apiError{Error: msg})
		return
	}
	s.changedWorkers()
	writeJSON(w, http.StatusOK, map[string]string{"settingsUrl": settingsURL})
}

func (s *Server) syncAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	if err := s.d.GitHub.Sync(ctx, id); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	s.changedWorkers()
	writeJSON(w, http.StatusOK, map[string]string{"message": "Repositories read from GitHub."})
}

// --- runner accounts -----------------------------------------------------------

// runnerAccountView is a runner account with what the Pools page shows.
type runnerAccountView struct {
	model.Account
	Health     AccountHealth   `json:"health"`
	InstallURL string          `json:"installUrl"`
	Repos      []relayRepoView `json:"repos"`
	Pools      []string        `json:"pools"` // names of the pools whose runs it starts
}

func (s *Server) listRunnerAccounts(w http.ResponseWriter, r *http.Request) {
	out := []runnerAccountView{}
	err := s.d.Store.View(func(tx *store.Tx) error {
		accs, err := tx.RunnerAccounts()
		if err != nil {
			return err
		}
		pools, err := tx.Pools()
		if err != nil {
			return err
		}
		for _, a := range accs {
			v := runnerAccountView{Account: a, Health: AccountHealth{RateRemaining: -1}, Repos: []relayRepoView{}, Pools: []string{}}
			if s.d.GitHub != nil {
				v.Health = s.d.GitHub.Health(a.ID)
				v.InstallURL = s.d.GitHub.InstallURL(a)
			}
			repos, err := tx.RunnerRepos(a.ID)
			if err != nil {
				return err
			}
			for _, p := range repos {
				v.Repos = append(v.Repos, relayRepoView{AccountID: a.ID, Owner: a.Owner, Runners: true, FullName: p.FullName, Private: p.Private})
			}
			for _, p := range pools {
				if p.AccountID == a.ID {
					v.Pools = append(v.Pools, p.Name)
				}
			}
			out = append(out, v)
		}
		return nil
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": out})
}

func (s *Server) runnerManifest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Org string `json:"org"`
	}
	if !decode(w, r, &req) {
		return
	}
	req.Org = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(req.Org), "@"))
	if req.Org != "" && !orgRe.MatchString(req.Org) {
		msg := "This is not an organisation name on GitHub: letters, digits and single dashes, as in github.com/your-org."
		writeJSON(w, http.StatusBadRequest, apiError{Error: msg, Fields: map[string]string{"org": msg}})
		return
	}
	form, err := s.d.GitHub.RunnerManifest(req.Org, origin(r)+"/github/return")
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, form)
}

// removeRunnerAccount forgets a runner account that no pool uses.
func (s *Server) removeRunnerAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := s.d.Store.View(func(tx *store.Tx) error {
		_, err := tx.RunnerAccount(id)
		return err
	}); err != nil {
		s.fail(w, err)
		return
	}
	s.removeAccount(w, r)
}

func (s *Server) syncRunnerAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := s.d.Store.View(func(tx *store.Tx) error {
		_, err := tx.RunnerAccount(id)
		return err
	}); err != nil {
		s.fail(w, err)
		return
	}
	s.syncAccount(w, r)
}

// --- settings ----------------------------------------------------------------

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	var set model.Settings
	if err := s.d.Store.View(func(tx *store.Tx) error {
		var err error
		set, err = tx.Settings()
		return err
	}); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": set, "defaults": model.DefaultSettings(), "version": s.d.Version})
}

var (
	labelRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	imageRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$`)
	emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	hostnRe = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
)

// numField is a number of the settings with the range and unit the
// interface shows it in.
type numField struct {
	key      string
	get      func(*model.Settings) int
	min, max int // in the stored unit
	factor   int // stored units per shown unit
	unit     string
}

var numFields = []numField{
	{"reservePct", func(s *model.Settings) int { return s.ReservePct }, 0, 50, 1, "%"},
	{"cpuSettleSec", func(s *model.Settings) int { return s.CPUSettleSec }, 0, 3600, 1, "seconds"},
	{"reserveMemMb", func(s *model.Settings) int { return s.ReserveMemMB }, 0, 64 * 1024, 1024, "GB"},
	{"minDiskFreeMb", func(s *model.Settings) int { return s.MinDiskFreeMB }, 1000, 10_000_000, 1000, "GB"},
	{"mirrorCapMb", func(s *model.Settings) int { return s.MirrorCapMB }, 1000, 10_000_000, 1000, "GB"},
	{"startTimeoutSec", func(s *model.Settings) int { return s.StartTimeoutSec }, 30, 1800, 1, "seconds"},
	{"idleTimeoutSec", func(s *model.Settings) int { return s.IdleTimeoutSec }, 60, 24 * 3600, 60, "minutes"},
	{"spareGraceSec", func(s *model.Settings) int { return s.SpareGraceSec }, 10, 3600, 1, "seconds"},
	{"jobTimeoutSec", func(s *model.Settings) int { return s.JobTimeoutSec }, 600, 5 * 24 * 3600, 3600, "hours"},
	{"failureThreshold", func(s *model.Settings) int { return s.FailureThreshold }, 1, 20, 1, "failed starts"},
	{"noOvertakeSec", func(s *model.Settings) int { return s.NoOvertakeSec }, 0, 24 * 3600, 60, "minutes"},
	{"historyDays", func(s *model.Settings) int { return s.HistoryDays }, 1, 365, 1, "days"},
}

// checkSettings returns an error per field, keyed by its JSON name (sizes
// as "sizes.2.cpus").
func checkSettings(set model.Settings) map[string]string {
	errs := map[string]string{}
	reserved := map[string]bool{"self-hosted": true, "linux": true, "x64": true}
	set.BaseLabel = strings.TrimSpace(set.BaseLabel)
	switch {
	case !labelRe.MatchString(set.BaseLabel):
		errs["baseLabel"] = "Use lowercase letters, digits, dots, dashes or underscores, like ci-plane."
	case reserved[set.BaseLabel]:
		errs["baseLabel"] = "This label is used by every self-hosted runner; pick one of your own, like ci-plane."
	}
	// Two sizes: standard and large. Their names are fixed; what a job of
	// each needs is the person's to say.
	if len(set.Sizes) != 2 || set.Sizes[0].Name != model.SizeStandard || set.Sizes[1].Name != model.SizeLarge {
		errs["sizes"] = "There are two sizes, standard and large."
	}
	taken := map[string]bool{model.SizeStandard: true, model.SizeLarge: true, set.BaseLabel: true}
	for l := range reserved {
		taken[l] = true
	}
	for i, z := range set.Sizes {
		k := fmt.Sprintf("sizes.%d.", i)
		if z.CPUs < 0.5 || z.CPUs > 256 {
			errs[k+"cpus"] = "From 0.5 to 256 free CPUs."
		}
		if z.MemMB < 512 || z.MemMB > 1024*1024 {
			errs[k+"memMb"] = "From 0.5 to 1024 GB."
		}
		if len(z.Aliases) > 12 {
			errs[k+"aliases"] = "Use at most 12 other labels."
		}
		for _, a := range z.Aliases {
			switch {
			case !labelRe.MatchString(a):
				errs[k+"aliases"] = "Use lowercase letters, digits and dashes, like size-m."
			case taken[a]:
				errs[k+"aliases"] = "The label " + a + " is taken already."
			}
			taken[a] = true
		}
	}
	if len(set.Sizes) == 2 && errs["sizes.0.memMb"] == "" && errs["sizes.1.memMb"] == "" && set.Sizes[1].MemMB < set.Sizes[0].MemMB {
		errs["sizes.1.memMb"] = "A large job gets at least the memory of a standard one."
	}
	for key, v := range map[string]string{"runnerImage": set.RunnerImage, "dindImage": set.DindImage, "mirrorImage": set.MirrorImage} {
		if !imageRe.MatchString(strings.TrimSpace(v)) {
			errs[key] = "Enter an image reference like ghcr.io/actions/actions-runner:latest."
		}
	}
	for _, f := range numFields {
		v := f.get(&set)
		if v < f.min || v > f.max {
			errs[f.key] = fmt.Sprintf("Enter a number from %s to %s %s.", shown(f.min, f.factor), shown(f.max, f.factor), f.unit)
		}
	}
	return errs
}

func shown(v, factor int) string {
	if factor == 1 {
		return fmt.Sprint(v)
	}
	return strings.TrimSuffix(strings.TrimSuffix(fmt.Sprintf("%.2f", float64(v)/float64(factor)), "0"), ".0")
}

func cleanSettings(set *model.Settings) {
	set.BaseLabel = strings.TrimSpace(set.BaseLabel)
	set.RunnerImage = strings.TrimSpace(set.RunnerImage)
	set.DindImage = strings.TrimSpace(set.DindImage)
	set.MirrorImage = strings.TrimSpace(set.MirrorImage)
	set.DefaultSize = model.SizeStandard
	for i := range set.Sizes {
		set.Sizes[i].Name = strings.ToLower(strings.TrimSpace(set.Sizes[i].Name))
		for j, a := range set.Sizes[i].Aliases {
			set.Sizes[i].Aliases[j] = strings.ToLower(strings.TrimSpace(a))
		}
	}
}

func (s *Server) validateSettings(w http.ResponseWriter, r *http.Request) {
	var set model.Settings
	if !decode(w, r, &set) {
		return
	}
	cleanSettings(&set)
	writeJSON(w, http.StatusOK, map[string]any{"fields": checkSettings(set)})
}

func (s *Server) saveSettings(w http.ResponseWriter, r *http.Request) {
	set := model.DefaultSettings()
	set.Sizes = nil // decoded as sent, not into the default ones
	if !decode(w, r, &set) {
		return
	}
	// The other labels of a size are not shown as a field: a save that
	// does not name them keeps them, so that workflows that use them keep
	// running.
	var cur model.Settings
	if err := s.d.Store.View(func(tx *store.Tx) error {
		var err error
		cur, err = tx.Settings()
		return err
	}); err != nil {
		s.fail(w, err)
		return
	}
	for i, z := range set.Sizes {
		if old, ok := cur.SizeByName(z.Name); ok && z.Aliases == nil && old.Name == z.Name {
			set.Sizes[i].Aliases = old.Aliases
		}
	}
	cleanSettings(&set)
	if errs := checkSettings(set); len(errs) > 0 {
		msg := "1 field needs attention."
		if len(errs) > 1 {
			msg = fmt.Sprintf("%d fields need attention.", len(errs))
		}
		writeJSON(w, http.StatusBadRequest, apiError{Error: "The settings were not saved: " + msg, Fields: errs})
		return
	}
	if err := s.d.Store.Tx(func(tx *store.Tx) error { return tx.SaveSettings(set) }); err != nil {
		s.fail(w, err)
		return
	}
	s.changedWorkers()
	writeJSON(w, http.StatusOK, map[string]any{"settings": set})
}

// --- Cloudflare --------------------------------------------------------------

func (s *Server) publicURL() string {
	if s.d.Cloudflare == nil {
		return ""
	}
	return s.d.Cloudflare.Status().PublicURL
}

func (s *Server) cloudflareStatus(w http.ResponseWriter, r *http.Request) {
	if s.d.Cloudflare == nil {
		writeError(w, http.StatusServiceUnavailable, "Cloudflare is not available.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":   s.d.Cloudflare.Status(),
		"tokenUrl": s.d.Cloudflare.TokenURL(),
		"task":     s.tasks.latest("cloudflare", "tunnel"),
	})
}

func (s *Server) cloudflareZones(w http.ResponseWriter, r *http.Request) {
	var req struct {
		APIToken string `json:"apiToken"`
	}
	if !decode(w, r, &req) {
		return
	}
	req.APIToken = strings.TrimSpace(req.APIToken)
	if req.APIToken == "" {
		msg := "Paste the API token you created on Cloudflare."
		writeJSON(w, http.StatusBadRequest, apiError{Error: msg, Fields: map[string]string{"apiToken": msg}})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	zones, err := s.d.Cloudflare.Zones(ctx, req.APIToken)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error(), Fields: map[string]string{"apiToken": err.Error()}})
		return
	}
	if zones == nil {
		zones = []Zone{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"zones": zones})
}

func cleanEmails(in []string) ([]string, string) {
	out := []string{}
	seen := map[string]bool{}
	for _, e := range in {
		for _, part := range strings.FieldsFunc(e, func(r rune) bool { return r == ',' || r == ';' || r == ' ' || r == '\n' }) {
			part = strings.ToLower(strings.TrimSpace(part))
			if part == "" || seen[part] {
				continue
			}
			if !emailRe.MatchString(part) {
				return nil, part + " is not an e-mail address."
			}
			seen[part] = true
			out = append(out, part)
		}
	}
	if len(out) == 0 {
		return nil, "Enter at least one e-mail address: only these people may sign in through Cloudflare."
	}
	if len(out) > 100 {
		return nil, "Enter at most 100 addresses."
	}
	return out, ""
}

func (s *Server) cloudflareSetup(w http.ResponseWriter, r *http.Request) {
	var req TunnelSetup
	if !decode(w, r, &req) {
		return
	}
	req.APIToken = strings.TrimSpace(req.APIToken)
	req.Hostname = strings.ToLower(strings.TrimSpace(req.Hostname))
	errs := map[string]string{}
	st := s.d.Cloudflare.Status()
	if req.APIToken == "" && !st.HasToken {
		errs["apiToken"] = "Paste the API token you created on Cloudflare."
	}
	if req.ZoneID == "" {
		errs["zoneId"] = "Choose the domain."
	}
	if !hostnRe.MatchString(req.Hostname) {
		errs["hostname"] = "Use letters, digits and dashes for the subdomain, like ci."
	}
	emails, msg := cleanEmails(req.Emails)
	if msg != "" {
		errs["emails"] = msg
	}
	if len(errs) > 0 {
		writeJSON(w, http.StatusBadRequest, apiError{Error: firstOf(errs), Fields: errs})
		return
	}
	req.Emails = emails
	task, _ := s.tasks.start("cloudflare", "tunnel", "Set up the tunnel to "+req.Hostname, 15*time.Minute,
		func(ctx context.Context, progress func(string)) (string, error) {
			defer s.hub.notify("state")
			if err := s.d.Cloudflare.Setup(ctx, req, progress); err != nil {
				return "", err
			}
			pub := s.d.Cloudflare.Status().PublicURL
			if pub == "" {
				pub = "https://" + req.Hostname
			}
			if s.d.GitHub != nil && s.hasAccounts() {
				progress("Pointing the webhooks of the GitHub Apps to " + pub + "/webhook")
				if err := s.d.GitHub.SetPublicURL(ctx, pub); err != nil {
					return "", fmt.Errorf("the tunnel works, but the GitHub Apps still send their webhooks to the old address: %v. Run the setup again to retry", err)
				}
			}
			return "The tunnel is up: " + pub + " asks for a Cloudflare login and /webhook answers.", nil
		})
	writeJSON(w, http.StatusOK, map[string]any{"task": task})
}

func (s *Server) hasAccounts() bool {
	n := 0
	_ = s.d.Store.View(func(tx *store.Tx) error {
		as, err := tx.Accounts()
		n = len(as)
		return err
	})
	return n > 0
}

func (s *Server) cloudflareEmails(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Emails []string `json:"emails"`
	}
	if !decode(w, r, &req) {
		return
	}
	emails, msg := cleanEmails(req.Emails)
	if msg != "" {
		writeJSON(w, http.StatusBadRequest, apiError{Error: msg, Fields: map[string]string{"emails": msg}})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	if err := s.d.Cloudflare.SetEmails(ctx, emails); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	s.hub.notify("state")
	writeJSON(w, http.StatusOK, map[string]any{"emails": emails})
}

func (s *Server) cloudflareRemove(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	if err := s.d.Cloudflare.Remove(ctx); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	s.hub.notify("state")
	writeJSON(w, http.StatusOK, map[string]string{"message": "The tunnel, its DNS record and the Access applications were deleted."})
}

// --- GitHub ------------------------------------------------------------------

var orgRe = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9]|-[A-Za-z0-9]){0,38}$`)

func (s *Server) githubManifest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Org string `json:"org"`
	}
	if !decode(w, r, &req) {
		return
	}
	req.Org = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(req.Org), "@"))
	if req.Org != "" && !orgRe.MatchString(req.Org) {
		msg := "This is not an organisation name on GitHub: letters, digits and single dashes, as in github.com/your-org."
		writeJSON(w, http.StatusBadRequest, apiError{Error: msg, Fields: map[string]string{"org": msg}})
		return
	}
	pub := s.publicURL()
	if pub == "" {
		writeError(w, http.StatusConflict, "Set up the Cloudflare tunnel first: GitHub needs a public address to send jobs to.")
		return
	}
	form, err := s.d.GitHub.Manifest(req.Org, pub, origin(r)+"/github/return")
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, form)
}

func (s *Server) githubComplete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code  string `json:"code"`
		State string `json:"state"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Code == "" || req.State == "" {
		writeError(w, http.StatusBadRequest, "GitHub did not send the app back. Start again with \"Add repository or organisation\".")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	a, err := s.d.GitHub.Complete(ctx, req.Code, req.State)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	s.changedWorkers()
	writeJSON(w, http.StatusOK, map[string]any{"account": a, "installUrl": s.d.GitHub.InstallURL(a)})
}

// githubInstalled runs after GitHub sent the browser back from an
// installation. GitHub names the installation but not the app, so every
// account is read again; that is cheap and makes the order of events moot.
func (s *Server) githubInstalled(w http.ResponseWriter, r *http.Request) {
	if err := s.syncAll(r.Context()); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	s.changedWorkers()
	s.listAccounts(w, r)
}

func (s *Server) githubSync(w http.ResponseWriter, r *http.Request) {
	s.githubInstalled(w, r)
}

func (s *Server) syncAll(ctx context.Context) error {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	var accs []model.Account
	if err := s.d.Store.View(func(tx *store.Tx) error {
		var err error
		if accs, err = tx.Accounts(); err != nil {
			return err
		}
		more, err := tx.RunnerAccounts()
		accs = append(accs, more...)
		return err
	}); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	var errs []error
	for _, a := range accs {
		if err := s.d.GitHub.Sync(ctx, a.ID); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", a.Owner, err))
		}
	}
	return errors.Join(errs...)
}

// --- setup assistant -----------------------------------------------------------

type setupResp struct {
	Done  bool            `json:"done"`
	Steps map[string]bool `json:"steps"`
	Demo  bool            `json:"demo"`
}

func (s *Server) setupDone() bool {
	done := false
	_ = s.d.Store.View(func(tx *store.Tx) error {
		_, err := tx.Get("setup.done")
		done = err == nil
		return nil
	})
	return done
}

func (s *Server) setupState(w http.ResponseWriter, r *http.Request) {
	sn, err := s.snapshot()
	if err != nil {
		s.fail(w, err)
		return
	}
	steps := map[string]bool{"password": s.d.Demo || s.auth.hasPassword() || via(r).Via == "tunnel",
		"cloudflare": false, "github": false, "worker": false, "job": false}
	if s.d.Cloudflare != nil {
		st := s.d.Cloudflare.Status()
		steps["cloudflare"] = st.Configured && st.Verified
	}
	for _, a := range sn.accounts {
		if a.InstallationID != 0 {
			steps["github"] = true
		}
	}
	for _, w := range sn.workers {
		if w.State == model.WorkerOnline {
			steps["worker"] = true
		}
	}
	steps["job"] = len(sn.counts) > 0
	writeJSON(w, http.StatusOK, setupResp{Done: s.setupDone(), Steps: steps, Demo: s.d.Demo})
}

func (s *Server) setupFinish(w http.ResponseWriter, r *http.Request) {
	if err := s.d.Store.Tx(func(tx *store.Tx) error { return tx.Set("setup.done", []byte("1")) }); err != nil {
		s.fail(w, err)
		return
	}
	s.hub.notify("state")
	writeJSON(w, http.StatusOK, map[string]bool{"done": true})
}
