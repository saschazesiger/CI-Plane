// Package store keeps all state in one SQLite file. It is the only place
// that knows SQL. One connection serialises every write.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/saschazesiger/CI-Plane/internal/model"
)

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// Store is the database.
type Store struct {
	db  *sql.DB
	now func() int64
}

const schema = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY, value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL, owner TEXT NOT NULL, owner_type TEXT NOT NULL,
  html_url TEXT NOT NULL DEFAULT '', installation_id INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, max_parallel INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, full_name TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1, max_parallel INTEGER NOT NULL DEFAULT 0, last_job_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS repos_account ON repos(account_id);
CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22,
  user TEXT NOT NULL DEFAULT 'ci-plane', host_key TEXT NOT NULL DEFAULT '', tier INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, draining INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'setup', state_reason TEXT NOT NULL DEFAULT '',
  cpus INTEGER NOT NULL DEFAULT 0, mem_mb INTEGER NOT NULL DEFAULT 0, disk_mb INTEGER NOT NULL DEFAULT 0,
  docker TEXT NOT NULL DEFAULT '', failures INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  cpu_priority TEXT NOT NULL DEFAULT 'normal'
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL DEFAULT 0, account_id INTEGER NOT NULL, repo_id INTEGER NOT NULL,
  repo TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', workflow TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
  html_url TEXT NOT NULL DEFAULT '', labels TEXT NOT NULL DEFAULT '[]', size TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', conclusion TEXT NOT NULL DEFAULT '',
  runner_id TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, next_try_at INTEGER NOT NULL DEFAULT 0,
  avoid_worker INTEGER NOT NULL DEFAULT 0, queued_at INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, waiting_since INTEGER NOT NULL DEFAULT 0,
  run_attempt INTEGER NOT NULL DEFAULT 0, rerun TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
CREATE INDEX IF NOT EXISTS jobs_updated ON jobs(updated_at);
CREATE TABLE IF NOT EXISTS runners (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, worker_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL, repo TEXT NOT NULL, job_id INTEGER NOT NULL DEFAULT 0, forge_id INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '[]', size TEXT NOT NULL DEFAULT '', cpus REAL NOT NULL DEFAULT 0, mem_mb INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', failed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, started_at INTEGER NOT NULL DEFAULT 0, online_at INTEGER NOT NULL DEFAULT 0,
  busy_at INTEGER NOT NULL DEFAULT 0, spare_at INTEGER NOT NULL DEFAULT 0, ended_at INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runners_state ON runners(state);
CREATE INDEX IF NOT EXISTS runners_worker ON runners(worker_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL,
  message TEXT NOT NULL, job_id INTEGER NOT NULL DEFAULT 0, runner_id TEXT NOT NULL DEFAULT '', worker_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL, repo TEXT NOT NULL DEFAULT '',
  tier INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  after_sec INTEGER NOT NULL DEFAULT 0, max INTEGER NOT NULL DEFAULT 1,
  standard TEXT NOT NULL DEFAULT '', large TEXT NOT NULL DEFAULT '', budget_min INTEGER NOT NULL DEFAULT 0,
  month TEXT NOT NULL DEFAULT '', used_sec INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0,
  paused_until INTEGER NOT NULL DEFAULT 0, pause_reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runner_accounts (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL, owner TEXT NOT NULL, owner_type TEXT NOT NULL,
  html_url TEXT NOT NULL DEFAULT '', installation_id INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runner_repos (
  id INTEGER NOT NULL, account_id INTEGER NOT NULL, full_name TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id);
CREATE INDEX IF NOT EXISTS events_worker ON events(worker_id);
`

// Open opens (and creates) the database in dir. An empty dir gives a
// private in-memory database, for tests.
func Open(dir string) (*Store, error) {
	dsn := "file::memory:?_pragma=foreign_keys(1)"
	if dir != "" {
		dsn = "file:" + filepath.Join(dir, "ci-plane.db") +
			"?_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=busy_timeout(10000)&_pragma=foreign_keys(1)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	// Columns added after the first release; CREATE TABLE IF NOT EXISTS
	// leaves an existing table as it is.
	for _, c := range []struct{ table, column, def string }{
		{"workers", "cpu_priority", "TEXT NOT NULL DEFAULT 'normal'"},
		{"jobs", "run_attempt", "INTEGER NOT NULL DEFAULT 0"},
		{"jobs", "rerun", "TEXT NOT NULL DEFAULT ''"},
		{"pools", "account_id", "INTEGER NOT NULL DEFAULT 0"},
	} {
		if err := addColumn(db, c.table, c.column, c.def); err != nil {
			db.Close()
			return nil, fmt.Errorf("upgrade the database: %w", err)
		}
	}
	// Asked on every pass of the engine; nearly always empty.
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS jobs_rerun ON jobs(rerun) WHERE rerun IN ('wanted','check')`); err != nil {
		db.Close()
		return nil, fmt.Errorf("upgrade the database: %w", err)
	}
	return &Store{db: db, now: Now}, nil
}

// addColumn adds a column unless the table has it.
func addColumn(db *sql.DB, table, column, def string) error {
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	_, err = db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + def)
	return err
}

// SetClock replaces the clock that stamps rows, for tests.
func (s *Store) SetClock(now func() int64) { s.now = now }

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// Now is the current time in Unix milliseconds.
func Now() int64 { return time.Now().UnixMilli() }

// Tx runs fn in one transaction. All methods of Tx see and change the same
// consistent state; an error rolls everything back.
func (s *Store) Tx(fn func(tx *Tx) error) error {
	t, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	// Also on a panic in fn: the one connection must come back.
	defer t.Rollback() // no effect after Commit
	if err := fn(&Tx{q: t, now: s.now}); err != nil {
		return err
	}
	return t.Commit()
}

// View is Tx for reading: fn's changes are still committed, the name only
// states the intent.
func (s *Store) View(fn func(tx *Tx) error) error { return s.Tx(fn) }

type querier interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// Tx is the set of operations, bound to a transaction.
type Tx struct {
	q   querier
	now func() int64
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func labelsJSON(l []string) string {
	if l == nil {
		l = []string{}
	}
	b, _ := json.Marshal(l)
	return string(b)
}

func parseLabels(s string) []string {
	var l []string
	_ = json.Unmarshal([]byte(s), &l)
	if l == nil {
		l = []string{}
	}
	return l
}

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// --- key/value -------------------------------------------------------------

// Get returns the raw value of a key.
func (t *Tx) Get(key string) ([]byte, error) {
	var v []byte
	err := t.q.QueryRow(`SELECT value FROM kv WHERE key=?`, key).Scan(&v)
	return v, notFound(err)
}

// Set stores the raw value of a key.
func (t *Tx) Set(key string, value []byte) error {
	_, err := t.q.Exec(`INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

// Delete removes a key.
func (t *Tx) Delete(key string) error {
	_, err := t.q.Exec(`DELETE FROM kv WHERE key=?`, key)
	return err
}

// Keys lists the keys that start with prefix.
func (t *Tx) Keys(prefix string) ([]string, error) {
	rows, err := t.q.Query(`SELECT key FROM kv WHERE substr(key, 1, ?) = ? ORDER BY key`, len(prefix), prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// GetJSON decodes the value of a key into v; ErrNotFound if unset.
func (t *Tx) GetJSON(key string, v any) error {
	b, err := t.Get(key)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// SetJSON stores v under key.
func (t *Tx) SetJSON(key string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return t.Set(key, b)
}

// Settings returns the settings, defaults filled in for anything unset.
func (t *Tx) Settings() (model.Settings, error) {
	s := model.DefaultSettings()
	// Decoding into the default sizes would leave their aliases on sizes
	// that are stored without any.
	sizes := s.Sizes
	s.Sizes = nil
	err := t.GetJSON("settings", &s)
	if errors.Is(err, ErrNotFound) {
		err = nil
	}
	if s.Sizes == nil {
		s.Sizes = sizes
	}
	return s, err
}

// SaveSettings stores the settings.
func (t *Tx) SaveSettings(s model.Settings) error { return t.SetJSON("settings", s) }

// --- accounts and repositories ---------------------------------------------

const accountCols = `id, slug, owner, owner_type, html_url, installation_id, enabled, max_parallel, created_at`

func scanAccount(r interface{ Scan(...any) error }) (model.Account, error) {
	var a model.Account
	err := r.Scan(&a.ID, &a.Slug, &a.Owner, &a.OwnerType, &a.HTMLURL, &a.InstallationID, &a.Enabled, &a.MaxParallel, &a.CreatedAt)
	return a, err
}

// SaveAccount inserts or replaces an account.
func (t *Tx) SaveAccount(a model.Account) error {
	_, err := t.q.Exec(`INSERT INTO accounts(`+accountCols+`) VALUES(?,?,?,?,?,?,?,?,?)
	  ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, owner=excluded.owner, owner_type=excluded.owner_type,
	  html_url=excluded.html_url, installation_id=excluded.installation_id, enabled=excluded.enabled, max_parallel=excluded.max_parallel`,
		a.ID, a.Slug, a.Owner, a.OwnerType, a.HTMLURL, a.InstallationID, b2i(a.Enabled), a.MaxParallel, a.CreatedAt)
	return err
}

// Account returns one account.
func (t *Tx) Account(id int64) (model.Account, error) {
	a, err := scanAccount(t.q.QueryRow(`SELECT `+accountCols+` FROM accounts WHERE id=?`, id))
	return a, notFound(err)
}

// Accounts lists all accounts.
func (t *Tx) Accounts() ([]model.Account, error) {
	rows, err := t.q.Query(`SELECT ` + accountCols + ` FROM accounts ORDER BY owner COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Account{}
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DeleteAccount removes an account and its repositories.
func (t *Tx) DeleteAccount(id int64) error {
	if _, err := t.q.Exec(`DELETE FROM repos WHERE account_id=?`, id); err != nil {
		return err
	}
	_, err := t.q.Exec(`DELETE FROM accounts WHERE id=?`, id)
	return err
}

const repoCols = `id, account_id, full_name, private, enabled, max_parallel, last_job_at`

func scanRepo(r interface{ Scan(...any) error }) (model.Repo, error) {
	var p model.Repo
	err := r.Scan(&p.ID, &p.AccountID, &p.FullName, &p.Private, &p.Enabled, &p.MaxParallel, &p.LastJobAt)
	return p, err
}

// UpsertRepo adds a repository or refreshes its name and visibility; the
// user's choices (enabled, limit) are kept, with one exception: a
// repository that was private and is public now is switched off, like any
// public repository that is new (see model.Repo.Enabled).
func (t *Tx) UpsertRepo(p model.Repo) error {
	_, err := t.q.Exec(`INSERT INTO repos(`+repoCols+`) VALUES(?,?,?,?,?,?,?)
	  ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, full_name=excluded.full_name,
	    enabled=CASE WHEN repos.private=1 AND excluded.private=0 THEN 0 ELSE repos.enabled END, private=excluded.private`,
		p.ID, p.AccountID, p.FullName, b2i(p.Private), b2i(p.Enabled), p.MaxParallel, p.LastJobAt)
	return err
}

// SaveRepo stores the user's choices of a repository.
func (t *Tx) SaveRepo(p model.Repo) error {
	_, err := t.q.Exec(`UPDATE repos SET enabled=?, max_parallel=?, last_job_at=? WHERE id=?`, b2i(p.Enabled), p.MaxParallel, p.LastJobAt, p.ID)
	return err
}

// Repo returns one repository.
func (t *Tx) Repo(id int64) (model.Repo, error) {
	p, err := scanRepo(t.q.QueryRow(`SELECT `+repoCols+` FROM repos WHERE id=?`, id))
	return p, notFound(err)
}

// Repos lists repositories, of one account or (0) of all.
func (t *Tx) Repos(accountID int64) ([]model.Repo, error) {
	q := `SELECT ` + repoCols + ` FROM repos`
	args := []any{}
	if accountID != 0 {
		q += ` WHERE account_id=?`
		args = append(args, accountID)
	}
	rows, err := t.q.Query(q+` ORDER BY full_name COLLATE NOCASE`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Repo{}
	for rows.Next() {
		p, err := scanRepo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DeleteRepo removes a repository.
func (t *Tx) DeleteRepo(id int64) error {
	_, err := t.q.Exec(`DELETE FROM repos WHERE id=?`, id)
	return err
}

// --- runner accounts ---------------------------------------------------------

// Runner accounts are GitHub Apps that only start the runners of pools in
// their relay repositories. They are kept apart from the accounts that
// receive jobs, so the engine and the Repositories page never see them.

const runnerAccountCols = `id, slug, owner, owner_type, html_url, installation_id, created_at`

func scanRunnerAccount(r interface{ Scan(...any) error }) (model.Account, error) {
	a := model.Account{Runners: true, Enabled: true} // a runner account cannot be switched off; its pools can
	err := r.Scan(&a.ID, &a.Slug, &a.Owner, &a.OwnerType, &a.HTMLURL, &a.InstallationID, &a.CreatedAt)
	return a, err
}

// SaveRunnerAccount inserts or replaces a runner account.
func (t *Tx) SaveRunnerAccount(a model.Account) error {
	_, err := t.q.Exec(`INSERT INTO runner_accounts(`+runnerAccountCols+`) VALUES(?,?,?,?,?,?,?)
	  ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, owner=excluded.owner, owner_type=excluded.owner_type,
	  html_url=excluded.html_url, installation_id=excluded.installation_id`,
		a.ID, a.Slug, a.Owner, a.OwnerType, a.HTMLURL, a.InstallationID, a.CreatedAt)
	return err
}

// RunnerAccount returns one runner account.
func (t *Tx) RunnerAccount(id int64) (model.Account, error) {
	a, err := scanRunnerAccount(t.q.QueryRow(`SELECT `+runnerAccountCols+` FROM runner_accounts WHERE id=?`, id))
	return a, notFound(err)
}

// RunnerAccounts lists all runner accounts.
func (t *Tx) RunnerAccounts() ([]model.Account, error) {
	rows, err := t.q.Query(`SELECT ` + runnerAccountCols + ` FROM runner_accounts ORDER BY owner COLLATE NOCASE, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Account{}
	for rows.Next() {
		a, err := scanRunnerAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DeleteRunnerAccount removes a runner account and its repositories.
func (t *Tx) DeleteRunnerAccount(id int64) error {
	if _, err := t.q.Exec(`DELETE FROM runner_repos WHERE account_id=?`, id); err != nil {
		return err
	}
	_, err := t.q.Exec(`DELETE FROM runner_accounts WHERE id=?`, id)
	return err
}

// SetRunnerRepos replaces the repositories of a runner account.
func (t *Tx) SetRunnerRepos(accountID int64, repos []model.Repo) error {
	if _, err := t.q.Exec(`DELETE FROM runner_repos WHERE account_id=?`, accountID); err != nil {
		return err
	}
	for _, p := range repos {
		if _, err := t.q.Exec(`INSERT OR REPLACE INTO runner_repos(id, account_id, full_name, private) VALUES(?,?,?,?)`,
			p.ID, accountID, p.FullName, b2i(p.Private)); err != nil {
			return err
		}
	}
	return nil
}

// RunnerRepos lists the repositories of a runner account, or (0) of all.
func (t *Tx) RunnerRepos(accountID int64) ([]model.Repo, error) {
	q := `SELECT id, account_id, full_name, private FROM runner_repos`
	args := []any{}
	if accountID != 0 {
		q += ` WHERE account_id=?`
		args = append(args, accountID)
	}
	rows, err := t.q.Query(q+` ORDER BY full_name COLLATE NOCASE`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Repo{}
	for rows.Next() {
		var p model.Repo
		if err := rows.Scan(&p.ID, &p.AccountID, &p.FullName, &p.Private); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// --- workers ---------------------------------------------------------------

const workerCols = `id, name, host, port, user, host_key, tier, position, enabled, draining, state, state_reason,
 cpus, mem_mb, disk_mb, docker, failures, last_seen_at, created_at, cpu_priority`

func scanWorker(r interface{ Scan(...any) error }) (model.Worker, error) {
	var w model.Worker
	err := r.Scan(&w.ID, &w.Name, &w.Host, &w.Port, &w.User, &w.HostKey, &w.Tier, &w.Position, &w.Enabled, &w.Draining,
		&w.State, &w.StateReason, &w.CPUs, &w.MemMB, &w.DiskMB, &w.Docker, &w.Failures, &w.LastSeenAt, &w.CreatedAt, &w.CPUPriority)
	return w, err
}

// AddWorker inserts a worker and returns it with its id.
func (t *Tx) AddWorker(w model.Worker) (model.Worker, error) {
	if w.CreatedAt == 0 {
		w.CreatedAt = t.now()
	}
	if w.State == "" {
		w.State = model.WorkerSetup
	}
	if w.CPUPriority == "" {
		w.CPUPriority = model.PriorityNormal
	}
	res, err := t.q.Exec(`INSERT INTO workers(name, host, port, user, host_key, tier, position, enabled, draining, state, state_reason,
	  cpus, mem_mb, disk_mb, docker, failures, last_seen_at, created_at, cpu_priority) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		w.Name, w.Host, w.Port, w.User, w.HostKey, w.Tier, w.Position, b2i(w.Enabled), b2i(w.Draining), w.State, w.StateReason,
		w.CPUs, w.MemMB, w.DiskMB, w.Docker, w.Failures, w.LastSeenAt, w.CreatedAt, w.CPUPriority)
	if err != nil {
		return w, err
	}
	w.ID, err = res.LastInsertId()
	return w, err
}

// SaveWorker stores every field of a worker.
func (t *Tx) SaveWorker(w model.Worker) error {
	_, err := t.q.Exec(`UPDATE workers SET name=?, host=?, port=?, user=?, host_key=?, tier=?, position=?, enabled=?, draining=?,
	  state=?, state_reason=?, cpus=?, mem_mb=?, disk_mb=?, docker=?, failures=?, last_seen_at=?, cpu_priority=? WHERE id=?`,
		w.Name, w.Host, w.Port, w.User, w.HostKey, w.Tier, w.Position, b2i(w.Enabled), b2i(w.Draining), w.State, w.StateReason,
		w.CPUs, w.MemMB, w.DiskMB, w.Docker, w.Failures, w.LastSeenAt, w.CPUPriority, w.ID)
	return err
}

// Worker returns one worker.
func (t *Tx) Worker(id int64) (model.Worker, error) {
	w, err := scanWorker(t.q.QueryRow(`SELECT `+workerCols+` FROM workers WHERE id=?`, id))
	return w, notFound(err)
}

// Workers lists all workers in the order of the interface.
func (t *Tx) Workers() ([]model.Worker, error) {
	rows, err := t.q.Query(`SELECT ` + workerCols + ` FROM workers ORDER BY tier, position, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Worker{}
	for rows.Next() {
		w, err := scanWorker(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// DeleteWorker removes a worker.
func (t *Tx) DeleteWorker(id int64) error {
	_, err := t.q.Exec(`DELETE FROM workers WHERE id=?`, id)
	return err
}

// --- pools -----------------------------------------------------------------

const poolCols = `id, name, kind, account_id, repo, tier, position, enabled, after_sec, max, standard, large, budget_min,
 month, used_sec, fails, paused_until, pause_reason, created_at`

func scanPool(r interface{ Scan(...any) error }) (model.Pool, error) {
	var p model.Pool
	err := r.Scan(&p.ID, &p.Name, &p.Kind, &p.AccountID, &p.Repo, &p.Tier, &p.Position, &p.Enabled, &p.AfterSec, &p.Max, &p.Standard, &p.Large,
		&p.BudgetMin, &p.Month, &p.UsedSec, &p.Fails, &p.PausedUntil, &p.PauseReason, &p.CreatedAt)
	return p, err
}

// AddPool stores a new pool and returns it with its id.
func (t *Tx) AddPool(p model.Pool) (model.Pool, error) {
	if p.CreatedAt == 0 {
		p.CreatedAt = t.now()
	}
	res, err := t.q.Exec(`INSERT INTO pools(name, kind, account_id, repo, tier, position, enabled, after_sec, max, standard, large, budget_min,
	  month, used_sec, fails, paused_until, pause_reason, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		p.Name, p.Kind, p.AccountID, p.Repo, p.Tier, p.Position, b2i(p.Enabled), p.AfterSec, p.Max, p.Standard, p.Large, p.BudgetMin,
		p.Month, p.UsedSec, p.Fails, p.PausedUntil, p.PauseReason, p.CreatedAt)
	if err != nil {
		return p, err
	}
	p.ID, err = res.LastInsertId()
	return p, err
}

// SavePool stores a pool.
func (t *Tx) SavePool(p model.Pool) error {
	_, err := t.q.Exec(`UPDATE pools SET name=?, kind=?, account_id=?, repo=?, tier=?, position=?, enabled=?, after_sec=?, max=?, standard=?, large=?,
	  budget_min=?, month=?, used_sec=?, fails=?, paused_until=?, pause_reason=? WHERE id=?`,
		p.Name, p.Kind, p.AccountID, p.Repo, p.Tier, p.Position, b2i(p.Enabled), p.AfterSec, p.Max, p.Standard, p.Large, p.BudgetMin,
		p.Month, p.UsedSec, p.Fails, p.PausedUntil, p.PauseReason, p.ID)
	return err
}

// Pool returns one pool.
func (t *Tx) Pool(id int64) (model.Pool, error) {
	p, err := scanPool(t.q.QueryRow(`SELECT `+poolCols+` FROM pools WHERE id=?`, id))
	return p, notFound(err)
}

// Pools lists the pools by tier, then position.
func (t *Tx) Pools() ([]model.Pool, error) {
	rows, err := t.q.Query(`SELECT ` + poolCols + ` FROM pools ORDER BY tier, position, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Pool{}
	for rows.Next() {
		p, err := scanPool(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DeletePool removes a pool.
func (t *Tx) DeletePool(id int64) error {
	_, err := t.q.Exec(`DELETE FROM pools WHERE id=?`, id)
	return err
}

// --- jobs ------------------------------------------------------------------

const jobCols = `id, run_id, account_id, repo_id, repo, name, workflow, branch, html_url, labels, size, state, reason, conclusion,
 runner_id, attempts, next_try_at, avoid_worker, queued_at, started_at, completed_at, updated_at, waiting_since,
 run_attempt, rerun`

func scanJob(r interface{ Scan(...any) error }) (model.Job, error) {
	var j model.Job
	var labels string
	err := r.Scan(&j.ID, &j.RunID, &j.AccountID, &j.RepoID, &j.Repo, &j.Name, &j.Workflow, &j.Branch, &j.HTMLURL, &labels, &j.Size,
		&j.State, &j.Reason, &j.Conclusion, &j.RunnerID, &j.Attempts, &j.NextTryAt, &j.AvoidWorker, &j.QueuedAt, &j.StartedAt,
		&j.CompletedAt, &j.UpdatedAt, &j.WaitingSince, &j.RunAttempt, &j.Rerun)
	j.Labels = parseLabels(labels)
	return j, err
}

// SaveJob inserts or replaces a job.
func (t *Tx) SaveJob(j model.Job) error {
	j.UpdatedAt = t.now()
	_, err := t.q.Exec(`INSERT OR REPLACE INTO jobs(`+jobCols+`) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		j.ID, j.RunID, j.AccountID, j.RepoID, j.Repo, j.Name, j.Workflow, j.Branch, j.HTMLURL, labelsJSON(j.Labels), j.Size,
		j.State, j.Reason, j.Conclusion, j.RunnerID, j.Attempts, j.NextTryAt, j.AvoidWorker, j.QueuedAt, j.StartedAt,
		j.CompletedAt, j.UpdatedAt, j.WaitingSince, j.RunAttempt, j.Rerun)
	return err
}

// Job returns one job.
func (t *Tx) Job(id int64) (model.Job, error) {
	j, err := scanJob(t.q.QueryRow(`SELECT `+jobCols+` FROM jobs WHERE id=?`, id))
	return j, notFound(err)
}

func (t *Tx) jobs(where string, args ...any) ([]model.Job, error) {
	rows, err := t.q.Query(`SELECT `+jobCols+` FROM jobs `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Job{}
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// JobsToRerun returns the jobs GitHub is to run again and the jobs for
// which that is still to be decided.
func (t *Tx) JobsToRerun() ([]model.Job, error) {
	return t.jobs(`WHERE rerun IN ('wanted','check') ORDER BY completed_at, id`)
}

// OpenJobs lists jobs that are queued, assigned or running, oldest first.

func (t *Tx) OpenJobs() ([]model.Job, error) {
	return t.jobs(`WHERE state IN ('queued','assigned','running') ORDER BY queued_at, id`)
}

// JobFilter narrows ListJobs.
type JobFilter struct {
	States []string
	Search string
	Limit  int
	Offset int
}

// ListJobs lists jobs, newest first, with the total count for the filter.
func (t *Tx) ListJobs(f JobFilter) ([]model.Job, int, error) {
	where, args := []string{"1=1"}, []any{}
	if len(f.States) > 0 {
		where = append(where, `state IN (`+strings.TrimSuffix(strings.Repeat("?,", len(f.States)), ",")+`)`)
		for _, s := range f.States {
			args = append(args, s)
		}
	}
	if f.Search != "" {
		where = append(where, `(repo LIKE ? OR name LIKE ? OR workflow LIKE ? OR branch LIKE ?)`)
		like := "%" + f.Search + "%"
		args = append(args, like, like, like, like)
	}
	w := `WHERE ` + strings.Join(where, " AND ")
	var total int
	if err := t.q.QueryRow(`SELECT COUNT(*) FROM jobs `+w, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	if f.Limit <= 0 {
		f.Limit = 50
	}
	jobs, err := t.jobs(w+` ORDER BY queued_at DESC, id DESC LIMIT ? OFFSET ?`, append(args, f.Limit, f.Offset)...)
	return jobs, total, err
}

// JobCounts returns the number of jobs per state.
func (t *Tx) JobCounts() (map[string]int, error) {
	rows, err := t.q.Query(`SELECT state, COUNT(*) FROM jobs GROUP BY state`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var s string
		var n int
		if err := rows.Scan(&s, &n); err != nil {
			return nil, err
		}
		out[s] = n
	}
	return out, rows.Err()
}

// WaitStats returns the median wait (queued until started, in ms) of jobs
// started since a time, and how many there were.
func (t *Tx) WaitStats(since int64) (medianMs int64, n int, err error) {
	rows, err := t.q.Query(`SELECT started_at - queued_at FROM jobs WHERE started_at >= ? AND queued_at > 0 ORDER BY 1`, since)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()
	var all []int64
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			return 0, 0, err
		}
		all = append(all, v)
	}
	if len(all) == 0 {
		return 0, 0, rows.Err()
	}
	return all[len(all)/2], len(all), rows.Err()
}

// --- runners ---------------------------------------------------------------

const runnerCols = `id, name, worker_id, account_id, repo_id, repo, job_id, forge_id, labels, size, cpus, mem_mb, state, error, failed,
 created_at, started_at, online_at, busy_at, spare_at, ended_at, removed_at`

func scanRunner(r interface{ Scan(...any) error }) (model.Runner, error) {
	var x model.Runner
	var labels string
	err := r.Scan(&x.ID, &x.Name, &x.WorkerID, &x.AccountID, &x.RepoID, &x.Repo, &x.JobID, &x.ForgeID, &labels, &x.Size, &x.CPUs,
		&x.MemMB, &x.State, &x.Error, &x.Failed, &x.CreatedAt, &x.StartedAt, &x.OnlineAt, &x.BusyAt, &x.SpareAt, &x.EndedAt, &x.RemovedAt)
	x.Labels = parseLabels(labels)
	return x, err
}

// SaveRunner inserts or replaces a runner.
func (t *Tx) SaveRunner(x model.Runner) error {
	_, err := t.q.Exec(`INSERT OR REPLACE INTO runners(`+runnerCols+`) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		x.ID, x.Name, x.WorkerID, x.AccountID, x.RepoID, x.Repo, x.JobID, x.ForgeID, labelsJSON(x.Labels), x.Size, x.CPUs,
		x.MemMB, x.State, x.Error, b2i(x.Failed), x.CreatedAt, x.StartedAt, x.OnlineAt, x.BusyAt, x.SpareAt, x.EndedAt, x.RemovedAt)
	return err
}

// Runner returns one runner by id.
func (t *Tx) Runner(id string) (model.Runner, error) {
	x, err := scanRunner(t.q.QueryRow(`SELECT `+runnerCols+` FROM runners WHERE id=?`, id))
	return x, notFound(err)
}

// RunnerByName returns one runner by its name.
func (t *Tx) RunnerByName(name string) (model.Runner, error) {
	x, err := scanRunner(t.q.QueryRow(`SELECT `+runnerCols+` FROM runners WHERE name=?`, name))
	return x, notFound(err)
}

func (t *Tx) runners(where string, args ...any) ([]model.Runner, error) {
	rows, err := t.q.Query(`SELECT `+runnerCols+` FROM runners `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Runner{}
	for rows.Next() {
		x, err := scanRunner(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// ActiveRunners lists every runner that is not removed, oldest first.
func (t *Tx) ActiveRunners() ([]model.Runner, error) {
	return t.runners(`WHERE state != 'removed' ORDER BY created_at, id`)
}

// RunnersOfWorker lists the latest runners of a worker, newest first.
func (t *Tx) RunnersOfWorker(workerID int64, limit int) ([]model.Runner, error) {
	return t.runners(`WHERE worker_id=? ORDER BY created_at DESC LIMIT ?`, workerID, limit)
}

// --- events ----------------------------------------------------------------

// AddEvent appends an event and returns it with id and time.
func (t *Tx) AddEvent(e model.Event) (model.Event, error) {
	if e.At == 0 {
		e.At = t.now()
	}
	if e.Level == "" {
		e.Level = model.LevelInfo
	}
	res, err := t.q.Exec(`INSERT INTO events(at, level, kind, message, job_id, runner_id, worker_id) VALUES(?,?,?,?,?,?,?)`,
		e.At, e.Level, e.Kind, e.Message, e.JobID, e.RunnerID, e.WorkerID)
	if err != nil {
		return e, err
	}
	e.ID, err = res.LastInsertId()
	return e, err
}

// EventFilter narrows Events. Zero fields are ignored.
type EventFilter struct {
	JobID    int64
	WorkerID int64
	MinLevel string // "warn" or "error"
	Limit    int
	Newest   bool // newest first instead of oldest first
}

// Events lists events.
func (t *Tx) Events(f EventFilter) ([]model.Event, error) {
	where, args := []string{"1=1"}, []any{}
	if f.JobID != 0 {
		where = append(where, `job_id=?`)
		args = append(args, f.JobID)
	}
	if f.WorkerID != 0 {
		where = append(where, `worker_id=?`)
		args = append(args, f.WorkerID)
	}
	switch f.MinLevel {
	case model.LevelWarn:
		where = append(where, `level IN ('warn','error')`)
	case model.LevelError:
		where = append(where, `level='error'`)
	}
	order := "ASC"
	if f.Newest {
		order = "DESC"
	}
	if f.Limit <= 0 {
		f.Limit = 200
	}
	rows, err := t.q.Query(`SELECT id, at, level, kind, message, job_id, runner_id, worker_id FROM events WHERE `+
		strings.Join(where, " AND ")+` ORDER BY id `+order+` LIMIT ?`, append(args, f.Limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Event{}
	for rows.Next() {
		var e model.Event
		if err := rows.Scan(&e.ID, &e.At, &e.Level, &e.Kind, &e.Message, &e.JobID, &e.RunnerID, &e.WorkerID); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Prune deletes finished jobs, removed runners and events older than a time.
func (t *Tx) Prune(before int64) error {
	for _, q := range []string{
		`DELETE FROM jobs WHERE state IN ('completed','ignored') AND updated_at < ?`,
		`DELETE FROM runners WHERE state='removed' AND removed_at < ?`,
		`DELETE FROM events WHERE at < ?`,
	} {
		if _, err := t.q.Exec(q, before); err != nil {
			return err
		}
	}
	return nil
}
