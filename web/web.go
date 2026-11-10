// Package web holds the interface: plain HTML, CSS and ES modules on the
// vendored Dashboard-Style, embedded into the binary.
package web

import "embed"

// FS is the interface as served at /.
//
//go:embed index.html favicon.svg theme.css app.css app vendor/dashboard-style
var FS embed.FS
