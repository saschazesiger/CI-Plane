// Command ci-plane starts ephemeral GitHub Actions runners on your own
// servers. Configuration comes from the environment:
//
//	CI_PLANE_DATA            where the database and the secret key live (default /data)
//	CI_PLANE_LISTEN          the web interface on the local network (default :8080)
//	CI_PLANE_TUNNEL_LISTEN   what cloudflared reaches (default 127.0.0.1:8081)
//	CI_PLANE_HOSTS           extra host names the web interface answers to, comma-separated
//	                         (IP addresses and names like server, server.lan, server.local always work)
//	CI_PLANE_ADMIN_PASSWORD  if set, becomes the admin password at start
//	CI_PLANE_SECRET_KEY      the key that encrypts secrets (default: secret.key in the data directory)
//	CI_PLANE_DEMO            1: run on simulated GitHub, Cloudflare and workers, nothing real is touched
//	CI_PLANE_DEMO_FRESH      1: the demo starts empty, as on a first run, with the login on
//	CI_PLANE_DEMO_SEED       the seed of the demo (default 1)
//	CI_PLANE_DEMO_SPEED      how fast the demo runs (default 1; 5 is five times as fast)
//	CI_PLANE_DEMO_FREEZE     1: the demo stops moving after a few seconds, for screenshots
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/demo"
	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// version is set at build time: -ldflags "-X main.version=v0.1.0".
var version = "dev"

type config struct {
	data, listen, tunnelListen string
	adminPassword              string
	demo, demoFresh, freeze    bool
	seed                       int64
	speed                      float64
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func truthy(key string) bool {
	switch strings.ToLower(env(key, "")) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func loadConfig() (config, error) {
	c := config{
		data:          env("CI_PLANE_DATA", "/data"),
		listen:        env("CI_PLANE_LISTEN", ":8080"),
		tunnelListen:  env("CI_PLANE_TUNNEL_LISTEN", "127.0.0.1:8081"),
		adminPassword: os.Getenv("CI_PLANE_ADMIN_PASSWORD"),
		demoFresh:     truthy("CI_PLANE_DEMO_FRESH"),
		freeze:        truthy("CI_PLANE_DEMO_FREEZE"),
		seed:          1,
		speed:         1,
	}
	c.demo = truthy("CI_PLANE_DEMO") || c.demoFresh
	if v := env("CI_PLANE_DEMO_SEED", ""); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return c, fmt.Errorf("CI_PLANE_DEMO_SEED must be a whole number, not %q", v)
		}
		c.seed = n
	}
	if v := env("CI_PLANE_DEMO_SPEED", ""); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f <= 0 || f > 100 {
			return c, fmt.Errorf("CI_PLANE_DEMO_SPEED must be a number from 0.1 to 100, not %q", v)
		}
		c.speed = f
	}
	return c, nil
}

func main() {
	logger := log.New(os.Stderr, "", log.LstdFlags)
	if err := run(logger); err != nil {
		logger.Printf("ci-plane: %v", err)
		os.Exit(1)
	}
}

func run(logger *log.Logger) error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var (
		st      *store.Store
		eng     *engine.Engine
		svc     Services
		runners []func(context.Context) // what runs until shutdown
		extra   http.Handler
		webhook http.Handler
		box     *secret.Box
	)
	if cfg.demo {
		d, err := demo.New(demo.Options{Seed: cfg.seed, Speed: cfg.speed, Freeze: cfg.freeze, Fresh: cfg.demoFresh, Logf: logger.Printf})
		if err != nil {
			return fmt.Errorf("start the demo: %w", err)
		}
		defer d.Close()
		st, eng = d.Store, d.Engine
		svc = Services{Workers: d.Workers, GitHub: d.GitHub, Cloudflare: d.Cloudflare}
		runners = append(runners, d.Run)
		extra = d.Pages
	} else {
		if err := os.MkdirAll(cfg.data, 0o700); err != nil {
			return fmt.Errorf("create the data directory %s: %w", cfg.data, err)
		}
		if st, err = store.Open(cfg.data); err != nil {
			return fmt.Errorf("open the database in %s: %w", cfg.data, err)
		}
		defer st.Close()
		if box, err = secret.Load(cfg.data); err != nil {
			return err
		}
		svc, err = buildServices(st, box, originOf(cfg.tunnelListen), logger.Printf)
		if err != nil {
			return err
		}
		eng = engine.New(st, svc.Forge, svc.Fleet)
		eng.Logf = logger.Printf
		webhook = svc.Webhook(eng.HandleJob)
		runners = append(runners, eng.Run)
		runners = append(runners, svc.Run...)
	}

	srv := api.New(api.Deps{
		Store: st, Engine: eng, Workers: svc.Workers, GitHub: svc.GitHub, Cloudflare: svc.Cloudflare, Box: box,
		Hosts:   strings.Split(env("CI_PLANE_HOSTS", ""), ","),
		Version: version, Demo: cfg.demo && !cfg.demoFresh, ResetPassword: cfg.adminPassword, Extra: extra,
		Logf: logger.Printf,
	})
	defer srv.Close()
	runners = append(runners, srv.Run)

	local := &http.Server{Addr: cfg.listen, Handler: srv.Local(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: time.Minute, IdleTimeout: 2 * time.Minute, ErrorLog: logger}
	tunnel := &http.Server{Addr: cfg.tunnelListen, Handler: srv.Tunnel(webhook), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: time.Minute, IdleTimeout: 2 * time.Minute, ErrorLog: logger}

	lnLocal, err := net.Listen("tcp", cfg.listen)
	if err != nil {
		return fmt.Errorf("listen on %s (CI_PLANE_LISTEN): %w", cfg.listen, err)
	}
	var lnTunnel net.Listener
	if !cfg.demo {
		if lnTunnel, err = net.Listen("tcp", cfg.tunnelListen); err != nil {
			return fmt.Errorf("listen on %s (CI_PLANE_TUNNEL_LISTEN): %w", cfg.tunnelListen, err)
		}
	}

	errc := make(chan error, 2)
	go func() { errc <- serve(local, lnLocal) }()
	if lnTunnel != nil {
		go func() { errc <- serve(tunnel, lnTunnel) }()
	}
	for _, r := range runners {
		go r(ctx)
	}
	banner(logger, cfg, lnLocal.Addr())

	select {
	case <-ctx.Done():
	case err = <-errc:
	}
	logger.Printf("Shutting down ...")
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Close() // ends the live streams, which would hold Shutdown up
	_ = local.Shutdown(shutdown)
	if lnTunnel != nil {
		_ = tunnel.Shutdown(shutdown)
	}
	stop()
	// Give the engine a moment to finish the step it is in.
	time.Sleep(200 * time.Millisecond)
	return err
}

// originOf is the URL cloudflared uses to reach the tunnel listener.
func originOf(listen string) string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "http://127.0.0.1:8081"
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func serve(s *http.Server, ln net.Listener) error {
	if err := s.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// banner tells the person who started CI-Plane where to go next.
func banner(logger *log.Logger, cfg config, addr net.Addr) {
	url := "http://localhost:" + portOf(addr)
	if host, _, _ := net.SplitHostPort(cfg.listen); host != "" && host != "0.0.0.0" && host != "::" {
		url = "http://" + net.JoinHostPort(host, portOf(addr))
	}
	lines := []string{"", "  CI-Plane " + version}
	switch {
	case cfg.demoFresh:
		lines = append(lines, "  Demo mode, starting empty: nothing real is touched.")
	case cfg.demo:
		lines = append(lines, "  Demo mode: simulated GitHub, Cloudflare and workers; nothing real is touched.")
	default:
		lines = append(lines, "  Data in "+cfg.data)
	}
	open := "  Open " + url + " in your browser"
	if host, _, _ := net.SplitHostPort(cfg.listen); host == "" || host == "0.0.0.0" || host == "::" {
		open += " (from another machine: http://<this host's address>:" + portOf(addr) + ")"
	}
	lines = append(lines, "", open+".", "")
	for _, l := range lines {
		logger.Print(l)
	}
}

func portOf(addr net.Addr) string {
	_, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		return "8080"
	}
	return port
}
