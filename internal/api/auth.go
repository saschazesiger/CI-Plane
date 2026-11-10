package api

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"

	"github.com/saschazesiger/CI-Plane/internal/store"
)

const (
	cookieName     = "ci_plane_session"
	sessionMaxAge  = 30 * 24 * time.Hour
	minPasswordLen = 10
	maxPasswordLen = 256
)

// passwordHash is the stored form of the admin password (Argon2id).
type passwordHash struct {
	Salt    []byte `json:"salt"`
	Hash    []byte `json:"hash"`
	Time    uint32 `json:"time"`
	Memory  uint32 `json:"memory"` // KiB
	Threads uint8  `json:"threads"`
}

// Parameters after OWASP's recommendation for Argon2id; they are stored
// with every hash, so they can grow later without breaking old ones.
const (
	argonTime    = 2
	argonMemory  = 19 * 1024
	argonThreads = 1
	argonKeyLen  = 32
)

func hashPassword(pw string) passwordHash {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		panic(err)
	}
	return passwordHash{
		Salt: salt, Time: argonTime, Memory: argonMemory, Threads: argonThreads,
		Hash: argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen),
	}
}

func (p passwordHash) matches(pw string) bool {
	if len(p.Hash) == 0 {
		return false
	}
	got := argon2.IDKey([]byte(pw), p.Salt, p.Time, p.Memory, p.Threads, uint32(len(p.Hash)))
	return subtle.ConstantTimeCompare(got, p.Hash) == 1
}

func checkNewPassword(pw string) error {
	n := utf8.RuneCountInString(pw)
	switch {
	case n < minPasswordLen:
		return fmt.Errorf("Use at least %d characters.", minPasswordLen)
	case len(pw) > maxPasswordLen:
		return fmt.Errorf("Use at most %d characters.", maxPasswordLen)
	}
	return nil
}

// session is one signed-in browser. Only the SHA-256 of its token is kept,
// so a copy of the database does not let anybody in.
type session struct {
	Expires int64 `json:"expires"` // Unix ms
}

// auth holds the password, the sessions and the login limits.
type auth struct {
	st   *store.Store
	logf func(string, ...any)

	mu       sync.Mutex
	sessions map[string]session // by token hash
	attempts map[string]*attempt
	now      func() time.Time
}

type attempt struct {
	fails int
	until time.Time // no attempt before this
	last  time.Time
}

func newAuth(st *store.Store, logf func(string, ...any)) *auth {
	a := &auth{st: st, logf: logf, sessions: map[string]session{}, attempts: map[string]*attempt{}, now: time.Now}
	// Sessions survive a restart, so an update does not sign everybody out.
	_ = st.View(func(tx *store.Tx) error {
		if err := tx.GetJSON("auth.sessions", &a.sessions); err != nil && !errors.Is(err, store.ErrNotFound) {
			logf("sessions: %v", err)
		}
		return nil
	})
	if a.sessions == nil {
		a.sessions = map[string]session{}
	}
	return a
}

func (a *auth) hasPassword() bool {
	has := false
	_ = a.st.View(func(tx *store.Tx) error {
		_, err := tx.Get("auth.password")
		has = err == nil
		return nil
	})
	return has
}

func (a *auth) setPassword(pw string) error {
	if err := checkNewPassword(pw); err != nil {
		return err
	}
	h := hashPassword(pw)
	return a.st.Tx(func(tx *store.Tx) error { return tx.SetJSON("auth.password", h) })
}

// setFirstPassword sets the password only if none is set, atomically, so
// two first visitors cannot both win.
func (a *auth) setFirstPassword(pw string) (bool, error) {
	if err := checkNewPassword(pw); err != nil {
		return false, err
	}
	h := hashPassword(pw)
	won := false
	err := a.st.Tx(func(tx *store.Tx) error {
		if _, err := tx.Get("auth.password"); err == nil {
			return nil
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		won = true
		return tx.SetJSON("auth.password", h)
	})
	return won, err
}

func (a *auth) verify(pw string) bool {
	var h passwordHash
	err := a.st.View(func(tx *store.Tx) error { return tx.GetJSON("auth.password", &h) })
	if err != nil {
		// Spend the same time, so a missing password is not visible.
		hashPassword(pw)
		return false
	}
	// Argon2 takes memory on purpose; a few at a time is enough, and a
	// flood of logins cannot exhaust the container.
	hashing <- struct{}{}
	defer func() { <-hashing }()
	return h.matches(pw)
}

var hashing = make(chan struct{}, 4)

// limited reports how long a client still has to wait before the next
// attempt. Five failures are free, then the wait doubles from 30 seconds
// up to 15 minutes.
func (a *auth) limited(ip string) time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	if at := a.attempts[ip]; at != nil {
		if d := at.until.Sub(a.now()); d > 0 {
			return d
		}
	}
	// Count the attempt before the password is checked, so guesses sent
	// in parallel cannot all slip through; success forgets the count.
	a.failedLocked(ip)
	return 0
}

// failed is kept for callers that count a failure by itself.
func (a *auth) failed(ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.failedLocked(ip)
}

func (a *auth) failedLocked(ip string) {
	now := a.now()
	at := a.attempts[ip]
	if at == nil || now.Sub(at.last) > time.Hour {
		at = &attempt{}
		a.attempts[ip] = at
	}
	at.fails++
	at.last = now
	if at.fails >= 5 {
		d := 30 * time.Second << (at.fails - 5)
		if d > 15*time.Minute || d <= 0 {
			d = 15 * time.Minute
		}
		at.until = now.Add(d)
	}
	// Keep the map small: forget clients that went quiet.
	if len(a.attempts) > 1000 {
		for k, v := range a.attempts {
			if now.Sub(v.last) > time.Hour {
				delete(a.attempts, k)
			}
		}
	}
}

func (a *auth) succeeded(ip string) {
	a.mu.Lock()
	delete(a.attempts, ip)
	a.mu.Unlock()
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// startSession creates a session and sets its cookie.
func (a *auth) startSession(w http.ResponseWriter, r *http.Request) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	exp := a.now().Add(sessionMaxAge)
	a.mu.Lock()
	a.sessions[tokenHash(token)] = session{Expires: exp.UnixMilli()}
	a.saveLocked()
	a.mu.Unlock()
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: token, Path: "/", Expires: exp, MaxAge: int(sessionMaxAge / time.Second),
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil,
	})
}

func (a *auth) endSession(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(cookieName); err == nil {
		a.mu.Lock()
		delete(a.sessions, tokenHash(c.Value))
		a.saveLocked()
		a.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil})
}

// dropSessions signs everybody out except the session of keepToken.
func (a *auth) dropSessions(keepToken string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	keep := ""
	if keepToken != "" {
		keep = tokenHash(keepToken)
	}
	for k := range a.sessions {
		if k != keep {
			delete(a.sessions, k)
		}
	}
	a.saveLocked()
}

func (a *auth) check(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	if err != nil || c.Value == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	s, ok := a.sessions[tokenHash(c.Value)]
	if !ok {
		return false
	}
	if s.Expires < a.now().UnixMilli() {
		delete(a.sessions, tokenHash(c.Value))
		a.saveLocked()
		return false
	}
	return true
}

func (a *auth) saveLocked() {
	now := a.now().UnixMilli()
	for k, s := range a.sessions {
		if s.Expires < now {
			delete(a.sessions, k)
		}
	}
	if err := a.st.Tx(func(tx *store.Tx) error { return tx.SetJSON("auth.sessions", a.sessions) }); err != nil {
		a.logf("save sessions: %v", err)
	}
}

// --- handlers ----------------------------------------------------------------

type sessionInfo struct {
	SignedIn      bool   `json:"signedIn"`
	NeedsPassword bool   `json:"needsPassword"` // first run: nobody set the password yet
	Via           string `json:"via"`           // local or tunnel
	Email         string `json:"email"`         // signed in through Cloudflare Access
	Demo          bool   `json:"demo"`
	Version       string `json:"version"`
	SetupDone     bool   `json:"setupDone"`
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	id := via(r)
	info := sessionInfo{Via: id.Via, Email: id.Email, Demo: s.d.Demo, Version: s.d.Version}
	info.SignedIn = s.signedIn(r)
	if id.Via == "local" && !s.d.Demo {
		info.NeedsPassword = !s.auth.hasPassword()
	}
	if info.SignedIn {
		info.SetupDone = s.setupDone()
	}
	writeJSON(w, http.StatusOK, info)
}

type passwordReq struct {
	Password string `json:"password"`
	Current  string `json:"current"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if d := s.auth.limited(ip); d > 0 {
		writeError(w, http.StatusTooManyRequests, fmt.Sprintf("Too many wrong passwords. Wait %s and try again.", roundWait(d)))
		return
	}
	var req passwordReq
	if !decode(w, r, &req) {
		return
	}
	if !s.auth.hasPassword() {
		writeError(w, http.StatusConflict, "No password is set yet. Reload the page to set one.")
		return
	}
	if !s.auth.verify(req.Password) {
		s.d.Logf("login: wrong password from %s", ip)
		writeError(w, http.StatusUnauthorized, "The password is wrong.")
		return
	}
	s.auth.succeeded(ip)
	s.auth.startSession(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"signedIn": true})
}

func (s *Server) firstPassword(w http.ResponseWriter, r *http.Request) {
	var req passwordReq
	if !decode(w, r, &req) {
		return
	}
	won, err := s.auth.setFirstPassword(req.Password)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error(), Fields: map[string]string{"password": err.Error()}})
		return
	}
	if !won {
		writeError(w, http.StatusConflict, "A password was set already. Sign in with it.")
		return
	}
	s.d.Logf("The admin password was set by the first visitor (%s)", clientIP(r))
	s.auth.startSession(w, r)
	s.hub.notify("state")
	writeJSON(w, http.StatusOK, map[string]bool{"signedIn": true})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	s.auth.endSession(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"signedIn": false})
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var req passwordReq
	if !decode(w, r, &req) {
		return
	}
	if err := checkNewPassword(req.Password); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error(), Fields: map[string]string{"password": err.Error()}})
		return
	}
	if s.auth.hasPassword() {
		ip := clientIP(r)
		if d := s.auth.limited(ip); d > 0 {
			writeError(w, http.StatusTooManyRequests, fmt.Sprintf("Too many wrong passwords. Wait %s and try again.", roundWait(d)))
			return
		}
		if !s.auth.verify(req.Current) {
			msg := "The current password is wrong."
			writeJSON(w, http.StatusBadRequest, apiError{Error: msg, Fields: map[string]string{"current": msg}})
			return
		}
		s.auth.succeeded(ip)
	}
	if err := s.auth.setPassword(req.Password); err != nil {
		s.fail(w, err)
		return
	}
	keep := ""
	if c, err := r.Cookie(cookieName); err == nil {
		keep = c.Value
	}
	s.auth.dropSessions(keep)
	writeJSON(w, http.StatusOK, map[string]string{"message": "Password changed. Other browsers were signed out."})
}

func roundWait(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%d seconds", int(d.Seconds()+0.99))
	}
	m := int(d.Minutes() + 0.99)
	if m == 1 {
		return "a minute"
	}
	return fmt.Sprintf("%d minutes", m)
}
