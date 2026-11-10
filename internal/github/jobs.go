package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
)

// ghJob is a workflow job as the API and the workflow_job webhook show it.
type ghJob struct {
	ID           int64    `json:"id"`
	RunID        int64    `json:"run_id"`
	Status       string   `json:"status"`
	Conclusion   string   `json:"conclusion"`
	CreatedAt    string   `json:"created_at"`
	StartedAt    string   `json:"started_at"`
	CompletedAt  string   `json:"completed_at"`
	Name         string   `json:"name"`
	WorkflowName string   `json:"workflow_name"`
	HeadBranch   string   `json:"head_branch"`
	HTMLURL      string   `json:"html_url"`
	Labels       []string `json:"labels"`
	RunnerName   string   `json:"runner_name"`
}

type ghRepo struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
	Private  bool   `json:"private"`
}

type ghRun struct {
	ID         int64  `json:"id"`
	Status     string `json:"status"`
	UpdatedAt  string `json:"updated_at"`
	RunAttempt int    `json:"run_attempt"`
	Repository ghRepo `json:"repository"`
}

// runCache holds the jobs of a run as last fetched.
type runCache struct {
	stamp string // what of the run was seen: changes when the run changes
	at    time.Time
	jobs  []engine.JobEvent
}

// runReuse is how long the jobs of an unchanged run are reused without
// asking GitHub. It bounds the delay should GitHub add a job to a run
// without touching the run's updated_at.
const runReuse = 5 * time.Minute

// Run states whose jobs may wait for a runner: a run that is in progress or
// waits for an approval can hold queued jobs (jobs with needs, or jobs
// beside the one that waits).
var openRunStates = []string{"queued", "in_progress", "waiting"}

// toEvent turns a job into what the engine needs.
func toEvent(j ghJob, repo ghRepo) engine.JobEvent {
	ev := engine.JobEvent{
		ID: j.ID, RunID: j.RunID, RepoID: repo.ID, Repo: repo.FullName, Private: repo.Private,
		Name: j.Name, Workflow: j.WorkflowName, Branch: j.HeadBranch, HTMLURL: j.HTMLURL,
		Labels: j.Labels, RunnerName: j.RunnerName, Conclusion: j.Conclusion,
	}
	if ev.Labels == nil {
		ev.Labels = []string{}
	}
	switch j.Status {
	case "queued":
		ev.Action, ev.At = "queued", millis(j.CreatedAt)
	case "in_progress":
		ev.Action, ev.At = "in_progress", millis(j.StartedAt)
	case "completed":
		ev.Action, ev.At = "completed", millis(j.CompletedAt)
	}
	if ev.Action != "completed" {
		ev.Conclusion = ""
	}
	return ev
}

// millis parses a GitHub time; 0 if empty or invalid ("now" for the engine).
func millis(v string) int64 {
	if v == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil || t.Year() < 2000 {
		return 0
	}
	return t.UnixMilli()
}

// QueuedJobs implements engine.Forge. It runs once a minute for every active
// repository, so it is built to be cheap: lists are fetched with ETags
// (unchanged answers do not count against the rate limit) and the jobs of a
// run are only fetched again when the run changed.
func (s *Service) QueuedJobs(ctx context.Context, accountID int64, repo string) ([]engine.JobEvent, error) {
	out, err := s.queuedJobs(ctx, accountID, repo)
	s.noteAPI(accountID, err)
	return out, err
}

func (s *Service) queuedJobs(ctx context.Context, accountID int64, repo string) ([]engine.JobEvent, error) {
	base, err := repoPath(repo)
	if err != nil {
		return nil, err
	}
	runs := map[int64]ghRun{}
	for _, status := range openRunStates {
		for page := 1; page <= 5; page++ {
			var res struct {
				TotalCount int     `json:"total_count"`
				Runs       []ghRun `json:"workflow_runs"`
			}
			_, err := s.getJSON(ctx, call{
				method:      http.MethodGet,
				path:        fmt.Sprintf("%s/actions/runs?status=%s&exclude_pull_requests=true&per_page=100&page=%d", base, status, page),
				auth:        authInstallation,
				account:     accountID,
				conditional: true,
			}, &res)
			if err != nil {
				return nil, err
			}
			for _, r := range res.Runs {
				runs[r.ID] = r
			}
			if len(res.Runs) < 100 {
				break
			}
		}
	}

	ids := make([]int64, 0, len(runs))
	for id := range runs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })

	out := []engine.JobEvent{}
	for _, id := range ids {
		run := runs[id]
		if run.Repository.FullName == "" {
			run.Repository.FullName = repo
		}
		jobs, err := s.runJobs(ctx, accountID, base, run)
		if err != nil {
			return nil, err
		}
		for _, ev := range jobs {
			if ev.Action == "queued" {
				ev.AccountID = accountID
				out = append(out, ev)
			}
		}
	}
	s.pruneRuns(accountID, repo, base, runs)
	return out, nil
}

func runKey(accountID int64, repo string, runID int64) string {
	return strconv.FormatInt(accountID, 10) + "|" + repo + "|" + strconv.FormatInt(runID, 10)
}

// runJobs returns the jobs of a run, from the cache while the run is
// unchanged.
func (s *Service) runJobs(ctx context.Context, accountID int64, base string, run ghRun) ([]engine.JobEvent, error) {
	key := runKey(accountID, run.Repository.FullName, run.ID)
	stamp := run.UpdatedAt + "|" + run.Status + "|" + strconv.Itoa(run.RunAttempt)
	s.mu.Lock()
	c, ok := s.runs[key]
	s.mu.Unlock()
	if ok && c.stamp == stamp && s.now().Sub(c.at) < runReuse {
		return c.jobs, nil
	}
	var jobs []engine.JobEvent
	for page := 1; page <= 10; page++ {
		var res struct {
			TotalCount int     `json:"total_count"`
			Jobs       []ghJob `json:"jobs"`
		}
		_, err := s.getJSON(ctx, call{
			method:      http.MethodGet,
			path:        fmt.Sprintf("%s/actions/runs/%d/jobs?filter=latest&per_page=100&page=%d", base, run.ID, page),
			auth:        authInstallation,
			account:     accountID,
			conditional: true,
		}, &res)
		if statusOf(err) == http.StatusNotFound {
			break // the run was deleted in between
		}
		if err != nil {
			return nil, err
		}
		for _, j := range res.Jobs {
			jobs = append(jobs, toEvent(j, run.Repository))
		}
		if len(res.Jobs) < 100 {
			break
		}
	}
	s.mu.Lock()
	s.runs[key] = runCache{stamp: stamp, at: s.now(), jobs: jobs}
	s.mu.Unlock()
	return jobs, nil
}

// pruneRuns drops what is cached about runs of a repository that are no
// longer open.
func (s *Service) pruneRuns(accountID int64, repo, base string, open map[int64]ghRun) {
	prefix := strconv.FormatInt(accountID, 10) + "|" + repo + "|"
	condPrefix := strconv.FormatInt(accountID, 10) + "|" + base + "/actions/runs/"
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.runs {
		if rest, ok := strings.CutPrefix(k, prefix); ok {
			if id, err := strconv.ParseInt(rest, 10, 64); err == nil {
				if _, still := open[id]; !still {
					delete(s.runs, k)
				}
			}
		}
	}
	for k := range s.cond {
		rest, ok := strings.CutPrefix(k, condPrefix)
		if !ok {
			continue
		}
		idStr, _, _ := strings.Cut(rest, "/")
		if id, err := strconv.ParseInt(idStr, 10, 64); err == nil {
			if _, still := open[id]; !still {
				delete(s.cond, k)
			}
		}
	}
}

// Job implements engine.Forge.
func (s *Service) Job(ctx context.Context, accountID int64, repo string, jobID int64) (engine.JobEvent, error) {
	base, err := repoPath(repo)
	if err != nil {
		return engine.JobEvent{}, err
	}
	path := base + "/actions/jobs/" + strconv.FormatInt(jobID, 10)
	var j ghJob
	_, err = s.getJSON(ctx, call{method: http.MethodGet, path: path, auth: authInstallation, account: accountID, conditional: true}, &j)
	if statusOf(err) == http.StatusNotFound {
		s.dropCond(accountID, path)
		return engine.JobEvent{}, engine.ErrGone
	}
	s.noteAPI(accountID, err)
	if err != nil {
		return engine.JobEvent{}, err
	}
	if j.ID == 0 {
		return engine.JobEvent{}, errors.New("GitHub returned an empty job; it will be asked again")
	}
	ev := toEvent(j, ghRepo{FullName: repo})
	ev.AccountID = accountID
	if ev.Action == "completed" {
		s.dropCond(accountID, path) // it will not be asked about again
	}
	return ev, nil
}

func (s *Service) dropCond(accountID int64, path string) {
	s.mu.Lock()
	delete(s.cond, strconv.FormatInt(accountID, 10)+"|"+path)
	s.mu.Unlock()
}
