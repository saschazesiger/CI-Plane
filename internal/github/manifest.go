package github

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// GitHub lets the manifest flow take an hour; a pending creation is kept a
// little longer so the error says "expired" rather than "unknown".
const manifestTTL = 70 * time.Minute

// pendingKey holds every pending creation, by state.
const pendingKey = "github:manifests"

// pending is a creation that waits for GitHub to send the browser back. It
// is kept in the store so a restart in between does not break the flow.
type pending struct {
	Org       string `json:"org"`
	PublicURL string `json:"publicUrl"`
	ReturnURL string `json:"returnUrl"`
	Expires   int64  `json:"expires"` // Unix ms
}

// manifest is GitHub's app manifest.
type manifest struct {
	Name               string            `json:"name"`
	URL                string            `json:"url"`
	Description        string            `json:"description"`
	HookAttributes     hookAttributes    `json:"hook_attributes"`
	RedirectURL        string            `json:"redirect_url"`
	SetupURL           string            `json:"setup_url"`
	SetupOnUpdate      bool              `json:"setup_on_update"`
	Public             bool              `json:"public"`
	DefaultEvents      []string          `json:"default_events"`
	DefaultPermissions map[string]string `json:"default_permissions"`
}

type hookAttributes struct {
	URL    string `json:"url"`
	Active bool   `json:"active"`
}

// GitHub limits app names to 34 characters.
const maxAppName = 34

var orgName = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)

// Manifest implements api.GitHub.
func (s *Service) Manifest(org, publicURL, returnURL string) (api.ManifestForm, error) {
	org = strings.TrimSpace(org)
	if org != "" && !orgName.MatchString(org) {
		return api.ManifestForm{}, fmt.Errorf("%q is not a valid organisation name on GitHub", org)
	}
	publicURL = strings.TrimRight(strings.TrimSpace(publicURL), "/")
	if u, err := url.Parse(publicURL); err != nil || u.Scheme != "https" || u.Host == "" {
		return api.ManifestForm{}, errors.New("GitHub can only send webhooks to an https address; set up the Cloudflare tunnel first")
	}
	if u, err := url.Parse(returnURL); err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return api.ManifestForm{}, fmt.Errorf("%q is not an address the browser can return to", returnURL)
	}

	state := randomHex(16)
	suffix := randomHex(3)
	m := manifest{
		Name:               appName(org, suffix),
		URL:                s.Homepage,
		Description:        "Starts ephemeral GitHub Actions runners on your own servers.",
		HookAttributes:     hookAttributes{URL: publicURL + "/webhook", Active: true},
		RedirectURL:        returnURL,
		SetupURL:           returnURL,
		SetupOnUpdate:      true,
		Public:             false,
		DefaultEvents:      []string{"workflow_job"},
		DefaultPermissions: permissions(org != ""),
	}
	body, err := json.Marshal(m)
	if err != nil {
		return api.ManifestForm{}, err
	}

	p := pending{Org: org, PublicURL: publicURL, ReturnURL: returnURL, Expires: s.now().Add(manifestTTL).UnixMilli()}
	if err := s.st.Tx(func(tx *store.Tx) error {
		all, err := loadPending(tx)
		if err != nil {
			return err
		}
		now := s.now().UnixMilli()
		for k, v := range all {
			if v.Expires < now {
				delete(all, k) // abandoned flows
			}
		}
		all[state] = p
		return tx.SetJSON(pendingKey, all)
	}); err != nil {
		return api.ManifestForm{}, err
	}

	action := s.WebURL + "/settings/apps/new"
	if org != "" {
		action = s.WebURL + "/organizations/" + url.PathEscape(org) + "/settings/apps/new"
	}
	return api.ManifestForm{Action: action + "?state=" + state, Manifest: string(body), State: state}, nil
}

// permissions are as narrow as GitHub allows. On an organisation runners
// are registered on the organisation; on a personal account only on a
// repository, which needs "Administration". Writing "Actions" is what
// lets CI-Plane run a job again whose worker was lost.
func permissions(org bool) map[string]string {
	p := map[string]string{"actions": "write", "metadata": "read"}
	if org {
		p["organization_self_hosted_runners"] = "write"
	} else {
		p["administration"] = "write"
	}
	return p
}

// appName is unique on GitHub thanks to the random suffix and fits its
// length limit.
func appName(org, suffix string) string {
	if org == "" {
		return "CI-Plane " + suffix
	}
	room := maxAppName - len("CI-Plane  ") - len(suffix)
	if len(org) > room {
		org = org[:room]
	}
	return "CI-Plane " + org + " " + suffix
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func loadPending(tx *store.Tx) (map[string]pending, error) {
	all := map[string]pending{}
	err := tx.GetJSON(pendingKey, &all)
	if errors.Is(err, store.ErrNotFound) {
		err = nil
	}
	if all == nil {
		all = map[string]pending{}
	}
	return all, err
}

// dropPending removes one pending creation.
func dropPending(tx *store.Tx, state string) error {
	all, err := loadPending(tx)
	if err != nil {
		return err
	}
	delete(all, state)
	return tx.SetJSON(pendingKey, all)
}

// Complete implements api.GitHub.
func (s *Service) Complete(ctx context.Context, code, state string) (model.Account, error) {
	code, state = strings.TrimSpace(code), strings.TrimSpace(state)
	if code == "" || state == "" {
		return model.Account{}, errors.New("GitHub did not pass back a code; start the creation of the app again")
	}
	var p pending
	found := false
	err := s.st.View(func(tx *store.Tx) error {
		all, err := loadPending(tx)
		p, found = all[state]
		return err
	})
	if err != nil {
		return model.Account{}, err
	}
	if !found {
		return model.Account{}, errors.New("this app creation was not started here or was already finished; start it again")
	}
	if s.now().UnixMilli() > p.Expires {
		_ = s.st.Tx(func(tx *store.Tx) error { return dropPending(tx, state) })
		return model.Account{}, errors.New("the app creation took longer than an hour and expired; start it again")
	}

	var out struct {
		ID      int64  `json:"id"`
		Slug    string `json:"slug"`
		HTMLURL string `json:"html_url"`
		Owner   struct {
			Login string `json:"login"`
			Type  string `json:"type"`
		} `json:"owner"`
		WebhookSecret string `json:"webhook_secret"`
		PEM           string `json:"pem"`
		ClientSecret  string `json:"client_secret"`
	}
	_, err = s.getJSON(ctx, call{method: http.MethodPost, path: "/app-manifests/" + url.PathEscape(code) + "/conversions"}, &out)
	switch statusOf(err) {
	case 0:
	case http.StatusNotFound, http.StatusUnprocessableEntity:
		return model.Account{}, errors.New("GitHub no longer accepts this code (it is valid for one hour and only once); start the creation of the app again")
	}
	if err != nil {
		return model.Account{}, err
	}
	if out.ID == 0 || out.PEM == "" || out.WebhookSecret == "" {
		return model.Account{}, errors.New("GitHub created the app but did not return its keys; delete the app on GitHub and start again")
	}
	if _, err := parseKey([]byte(out.PEM)); err != nil {
		return model.Account{}, errors.New("GitHub returned a private key CI-Plane cannot read; delete the app on GitHub and start again")
	}
	ownerType := out.Owner.Type
	if ownerType != "Organization" {
		ownerType = "User"
	}
	acc := model.Account{
		ID: out.ID, Slug: out.Slug, Owner: out.Owner.Login, OwnerType: ownerType, HTMLURL: out.HTMLURL,
		Enabled: true, CreatedAt: s.now().UnixMilli(),
	}
	err = s.st.Tx(func(tx *store.Tx) error {
		if err := tx.SaveAccount(acc); err != nil {
			return err
		}
		if err := s.box.Put(tx, keyName(acc.ID), []byte(out.PEM)); err != nil {
			return err
		}
		if err := s.box.Put(tx, hookName(acc.ID), []byte(out.WebhookSecret)); err != nil {
			return err
		}
		if out.ClientSecret != "" {
			if err := s.box.Put(tx, clientName(acc.ID), []byte(out.ClientSecret)); err != nil {
				return err
			}
		}
		return dropPending(tx, state)
	})
	if err != nil {
		return model.Account{}, fmt.Errorf("the app %s was created on GitHub but could not be stored (%v); delete it on GitHub (%s) and start again", acc.Slug, err, acc.HTMLURL)
	}
	s.forget(acc.ID)
	return acc, nil
}

// InstallURL implements api.GitHub.
func (s *Service) InstallURL(a model.Account) string {
	return s.WebURL + "/apps/" + url.PathEscape(a.Slug) + "/installations/new"
}

// settingsURL is the page of an app where its owner can delete it.
func (s *Service) settingsURL(a model.Account) string {
	if a.IsOrg() {
		return s.WebURL + "/organizations/" + url.PathEscape(a.Owner) + "/settings/apps/" + url.PathEscape(a.Slug) + "/advanced"
	}
	return s.WebURL + "/settings/apps/" + url.PathEscape(a.Slug) + "/advanced"
}

// Remove implements api.GitHub. GitHub has no API to delete an app, so the
// user is sent to its settings page.
func (s *Service) Remove(_ context.Context, accountID int64) (string, error) {
	var a model.Account
	err := s.st.Tx(func(tx *store.Tx) error {
		var err error
		if a, err = tx.Account(accountID); err != nil {
			return err
		}
		if err := tx.DeleteAccount(accountID); err != nil {
			return err
		}
		for _, n := range []string{keyName(accountID), hookName(accountID), clientName(accountID)} {
			if err := s.box.Drop(tx, n); err != nil {
				return err
			}
		}
		return nil
	})
	if errors.Is(err, store.ErrNotFound) {
		return "", errors.New("this account was already removed")
	}
	if err != nil {
		return "", err
	}
	s.forget(accountID)
	return s.settingsURL(a), nil
}

// SetPublicURL implements api.GitHub.
func (s *Service) SetPublicURL(ctx context.Context, publicURL string) error {
	publicURL = strings.TrimRight(strings.TrimSpace(publicURL), "/")
	if u, err := url.Parse(publicURL); err != nil || u.Scheme != "https" || u.Host == "" {
		return errors.New("GitHub can only send webhooks to an https address")
	}
	var accs []model.Account
	if err := s.st.View(func(tx *store.Tx) error {
		var err error
		accs, err = tx.Accounts()
		return err
	}); err != nil {
		return err
	}
	var failed []string
	for _, a := range accs {
		_, err := s.do(ctx, call{
			method: http.MethodPatch, path: "/app/hook/config", auth: authApp, account: a.ID,
			body: map[string]any{"url": publicURL + "/webhook", "content_type": "json", "insecure_ssl": "0"},
		})
		s.noteAPI(a.ID, err)
		if err != nil {
			failed = append(failed, a.Slug+": "+err.Error())
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("the webhook address could not be changed for %s; try again", strings.Join(failed, "; "))
	}
	return nil
}
