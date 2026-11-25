// Package web holds the interface: plain HTML, CSS and ES modules on Z-Dash,
// embedded into the binary. Z-Dash itself and the shell (sign-in, account,
// tunnel and password settings) come from the Z-Dash server module, which
// serves them under /z-dash/; only CI-Plane's own files are here.
package web

import "embed"

// FS is the interface as served at /.
//
//go:embed index.html favicon.svg theme.css app.css app
var FS embed.FS
