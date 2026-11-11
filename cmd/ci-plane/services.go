package main

import (
	"context"
	"net/http"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/cloudflare"
	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/github"
	"github.com/saschazesiger/CI-Plane/internal/node"
	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// Services are the real connections to GitHub, Cloudflare and the workers.
type Services struct {
	Forge      engine.Forge // GitHub, as the engine needs it
	Fleet      engine.Fleet // the workers, as the engine needs it
	Workers    api.Workers  // the workers, as the interface needs them
	GitHub     api.GitHub   // the GitHub Apps
	Cloudflare api.Cloudflare
	Relay      *github.Relay // the failover to GitHub-hosted runners
	// Webhook builds the handler for GitHub's webhooks on the tunnel listener.
	Webhook func(onJob func(engine.JobEvent) error) http.Handler
	Run     []func(ctx context.Context) // background loops, run until shutdown
}

// buildServices constructs the real services. origin is where cloudflared
// reaches CI-Plane.
func buildServices(st *store.Store, box *secret.Box, origin string, logf func(string, ...any)) (Services, error) {
	nodes, err := node.New(st, box, logf)
	if err != nil {
		return Services{}, err
	}
	gh := github.New(st, box, logf)
	cf := cloudflare.New(st, box, origin, logf)
	// Runs of the relay workflow reach CI-Plane through the tunnel only.
	relay := github.NewRelay(gh, func() string {
		if st := cf.Status(); st.Connected {
			return st.PublicURL
		}
		return ""
	})
	return Services{
		Forge: gh, Fleet: nodes, Workers: nodes, GitHub: gh, Cloudflare: cf, Relay: relay,
		Webhook: gh.WebhookHandler,
		Run:     []func(context.Context){nodes.Run, gh.Run, cf.Run},
	}, nil
}
