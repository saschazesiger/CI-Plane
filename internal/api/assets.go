package api

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
)

// assets serves the embedded interface from memory with strong ETags. The
// page itself is always revalidated; scripts, styles and fonts may be kept
// for a short while and are revalidated after that, so an update shows
// within minutes without a build step that renames files.
type assets struct {
	files map[string]asset
}

type asset struct {
	data  []byte
	etag  string
	ctype string
}

func loadAssets(fsys fs.FS) (*assets, error) {
	a := &assets{files: map[string]asset{}}
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if strings.HasSuffix(p, ".go") || strings.HasSuffix(p, ".md") {
			return nil
		}
		b, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		ct := mime.TypeByExtension(path.Ext(p))
		switch path.Ext(p) {
		case ".js", ".mjs":
			ct = "text/javascript; charset=utf-8"
		case ".css":
			ct = "text/css; charset=utf-8"
		case ".html":
			ct = "text/html; charset=utf-8"
		case ".woff2":
			ct = "font/woff2"
		case ".svg":
			ct = "image/svg+xml"
		}
		if ct == "" {
			ct = "application/octet-stream"
		}
		a.files["/"+p] = asset{data: b, etag: `"` + hex.EncodeToString(sum[:12]) + `"`, ctype: ct}
		return nil
	})
	return a, err
}

func (a *assets) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := r.URL.Path
	if p == "/" || p == "/index.html" {
		p = "/index.html"
	}
	f, ok := a.files[p]
	// The vendored design system keeps its tools and checksums out of the page.
	if !ok || strings.HasPrefix(p, "/vendor/dashboard-style/tools/") {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", f.ctype)
	h.Set("ETag", f.etag)
	if p == "/index.html" {
		h.Set("Cache-Control", "no-cache")
	} else {
		h.Set("Cache-Control", "public, max-age=300")
	}
	if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, f.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(f.data)
}

// githubReturn is where GitHub sends the browser back to, after creating an
// app (?code&state) and after installing it (?installation_id). The page
// finishes the step itself, with a signed-in request, so this answer needs
// no session (the SameSite=Strict cookie is not sent on a navigation that
// comes from github.com).
func (s *Server) githubReturn(w http.ResponseWriter, r *http.Request) {
	q := url.Values{}
	for _, k := range []string{"code", "state", "installation_id", "setup_action"} {
		if v := r.URL.Query().Get(k); v != "" {
			q.Set(k, v)
		}
	}
	http.Redirect(w, r, "/#/github?"+q.Encode(), http.StatusSeeOther)
}
