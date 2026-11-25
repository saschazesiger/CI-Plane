package main

import (
	"context"
	"net/http"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/github"
	"github.com/saschazesiger/CI-Plane/internal/node"
	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// Services are the real connections to GitHub and the workers; the
// Cloudflare tunnel belongs to the Z-Dash server.
type Services struct {
	Forge   engine.Forge  // GitHub, as the engine needs it
	Fleet   engine.Fleet  // the workers, as the engine needs it
	Workers api.Workers   // the workers, as the interface needs them
	GitHub  api.GitHub    // the GitHub Apps
	Relay   *github.Relay // the failover to GitHub-hosted runners
	// Webhook builds the handler for GitHub's webhooks on the tunnel listener.
	Webhook func(onJob func(engine.JobEvent) error) http.Handler
	Run     []func(ctx context.Context) // background loops, run until shutdown
}

// buildServices constructs the real services. publicURL is the tunnel's
// address while it is connected, "" otherwise.
func buildServices(st *store.Store, box *secret.Box, publicURL func() string, logf func(string, ...any)) (Services, error) {
	nodes, err := node.New(st, box, logf)
	if err != nil {
		return Services{}, err
	}
	gh := github.New(st, box, logf)
	// Runs of the relay workflow reach CI-Plane through the tunnel only.
	relay := github.NewRelay(gh, publicURL)
	// A runner on a machine of a pool starts with the script of a worker.
	relay.Script = node.HostedStartScript
	return Services{
		Forge: gh, Fleet: nodes, Workers: nodes, GitHub: gh, Relay: relay,
		Webhook: gh.WebhookHandler,
		Run:     []func(context.Context){nodes.Run, gh.Run},
	}, nil
}
