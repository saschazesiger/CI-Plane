package demo

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"strconv"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// The pages below play GitHub's part in the demo: the browser is sent
// there to "create" and "install" an app, and comes back the way it would
// from github.com. They are built from Dashboard-Style like the interface.

var page = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="en" class="ds-theme ds-base">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}} · GitHub (demo)</title>
<link rel="stylesheet" href="/vendor/dashboard-style/fonts/fonts.css">
<link rel="stylesheet" href="/vendor/dashboard-style/ds.css">
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/vendor/dashboard-style/themes/dark.css" media="(prefers-color-scheme: dark)">
</head>
<body class="ds-auth">
<div class="ds-auth__alert"><div class="ds-alert" role="status"><span class="ds-alert__text"><strong>Demo:</strong> this page plays GitHub's part. Nothing is sent to github.com.</span></div></div>
<section class="ds-card ds-card--elevated ds-auth__card" aria-labelledby="title">
<h1 class="ds-card__title" id="title">{{.Title}}</h1>
<p class="ds-muted">{{.Lead}}</p>
{{if .Facts}}<ul class="ds-kv-list">{{range .Facts}}<li><span>{{.K}}</span><strong>{{.V}}</strong></li>{{end}}</ul>{{end}}
{{if .Choices}}<div class="ds-radios" role="radiogroup" aria-label="Repository access">{{range $i, $c := .Choices}}<label class="ds-radio"><input type="radio" name="access" value="{{$i}}"{{if eq $i 0}} checked{{end}}><span><strong>{{$c.K}}</strong><small>{{$c.V}}</small></span></label>{{end}}</div>{{end}}
<div class="ds-form-actions"><a class="ds-btn ds-btn--primary" href="{{.Go}}">{{.GoLabel}}</a><a class="ds-btn ds-btn--text" href="/">Cancel</a></div>
</section>
</body>
</html>`))

type kv struct{ K, V string }

type pageData struct {
	Title, Lead string
	Facts       []kv
	Choices     []kv
	Go, GoLabel string
}

func render(w http.ResponseWriter, data pageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = page.Execute(w, data)
}

func (d *Demo) pages() http.Handler {
	mux := http.NewServeMux()
	g := d.GitHub

	// GitHub's "create app from manifest" page.
	mux.HandleFunc("POST /demo/github/new", func(w http.ResponseWriter, r *http.Request) {
		state := r.URL.Query().Get("state")
		g.mu.Lock()
		ms, ok := g.states[state]
		g.mu.Unlock()
		if !ok {
			http.Error(w, "This demo link expired. Start again from CI-Plane.", http.StatusNotFound)
			return
		}
		var manifest struct {
			Name  string `json:"name"`
			Hooks struct {
				URL string `json:"url"`
			} `json:"hook_attributes"`
		}
		_ = json.Unmarshal([]byte(r.FormValue("manifest")), &manifest)
		owner := "your personal account"
		if ms.org != "" {
			owner = "the organisation " + ms.org
		}
		back, _ := url.Parse(ms.returnURL)
		q := url.Values{"code": {ms.code}, "state": {state}}
		back.RawQuery = q.Encode()
		render(w, pageData{
			Title: "Create GitHub App for " + orElse(ms.org, "demo-user"),
			Lead:  "GitHub shows the app CI-Plane asks for. It will belong to " + owner + ".",
			Facts: []kv{{"Name", manifest.Name}, {"Webhook", manifest.Hooks.URL}, {"Events", "Workflow job"},
				{"Access", "Actions: read · Metadata: read · Self-hosted runners: write"}},
			Go: back.String(), GoLabel: "Create GitHub App for " + orElse(ms.org, "demo-user"),
		})
	})

	// GitHub's installation page.
	mux.HandleFunc("GET /demo/github/install", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.URL.Query().Get("app"), 10, 64)
		var a model.Account
		if err := d.Store.View(func(tx *store.Tx) error { var err error; a, err = tx.Account(id); return err }); err != nil {
			http.Error(w, "This app does not exist in the demo.", http.StatusNotFound)
			return
		}
		render(w, pageData{
			Title:   "Install " + a.Slug,
			Lead:    "GitHub asks where the app may be used. Choose the repositories whose jobs CI-Plane should run.",
			Choices: []kv{{"All repositories", "This applies to current and future repositories of " + a.Owner + "."}, {"Only select repositories", "Pick them from a list on GitHub."}},
			Go:      fmt.Sprintf("/demo/github/install/done?app=%d", a.ID), GoLabel: "Install",
		})
	})

	mux.HandleFunc("GET /demo/github/install/done", func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.URL.Query().Get("app"), 10, 64)
		g.markInstalled(id)
		q := url.Values{"installation_id": {strconv.FormatInt(61_000_000+id%1000, 10)}, "setup_action": {"install"}}
		http.Redirect(w, r, g.returnURLFor()+"?"+q.Encode(), http.StatusSeeOther)
	})

	// The settings page of an app, where it would be deleted.
	mux.HandleFunc("GET /demo/github/app", func(w http.ResponseWriter, r *http.Request) {
		slug := r.URL.Query().Get("slug")
		render(w, pageData{
			Title: "Settings of " + slug,
			Lead:  "On GitHub you would delete the app here (Advanced, Delete GitHub App). CI-Plane has forgotten it already.",
			Go:    "/#/repositories", GoLabel: "Back to CI-Plane",
		})
	})
	return mux
}
