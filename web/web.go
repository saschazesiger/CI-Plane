// Package web holds the interface: plain HTML, CSS and ES modules on the
// vendored Z-Dash, embedded into the binary. Of the copy only what the page
// loads: the minified build, its fonts and the dark theme.
package web

import "embed"

// FS is the interface as served at /.
//
//go:embed index.html favicon.svg theme.css app.css app
//go:embed vendor/z-dash/ds.min.css vendor/z-dash/ds.min.css.map vendor/z-dash/ds.min.js
//go:embed vendor/z-dash/fonts vendor/z-dash/themes/dark.css vendor/z-dash/LICENSE vendor/z-dash/VERSION
var FS embed.FS
