package github

import (
	"strings"
	"testing"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

func TestPoolUsageOfAnOrganisation(t *testing.T) {
	e := newEnv(t)
	e.addRunnerApp(61, "acme", "ci-plane-runners-acme", 610, model.Repo{ID: 1, FullName: "acme/relay", Private: true})
	e.gh.usage["organizations/acme"] = []usageItem{
		// As GitHub reports them: the SKU in words, the repository without its owner.
		{Product: "actions", SKU: "Actions Linux", Quantity: 100, UnitType: "Minutes", GrossAmount: 0.6, NetAmount: 0, RepositoryName: "acme/relay"},
		{Product: "actions", SKU: "Actions Linux", Quantity: 50, UnitType: "Minutes", GrossAmount: 0.3, NetAmount: 0.3, RepositoryName: "relay"},
		{Product: "Actions", SKU: "actions_linux_4_core", Quantity: 20, UnitType: "minutes", GrossAmount: 0.24, NetAmount: 0.24, RepositoryName: "acme/relay"},
		{Product: "actions", SKU: "Actions Linux", Quantity: 1000, UnitType: "Minutes", GrossAmount: 6, NetAmount: 1, RepositoryName: "api"},
		{Product: "actions", SKU: "Actions storage", Quantity: 3, UnitType: "GigabyteHours", GrossAmount: 9, NetAmount: 9, RepositoryName: "acme/relay"},
		{Product: "packages", SKU: "packages_storage", Quantity: 1, UnitType: "GigabyteHours", GrossAmount: 2, NetAmount: 2, RepositoryName: "acme/relay"},
	}
	e.gh.budgetList["acme"] = []ghBudget{
		{ID: "b1", Type: "ProductPricing", Amount: 50, Stop: true, Scope: "organization", Entity: "acme", Consumed: 12, ProductSKU: "actions"},
		{ID: "b2", Type: "SkuPricing", Amount: 5, Stop: true, Scope: "repository", Entity: "acme/relay", Consumed: 5, ProductSKU: "actions_linux"},
		{ID: "b7", Type: "SkuPricing", Amount: 5, Stop: true, Scope: "organization", Entity: "acme", Consumed: 5, ProductSKU: "actions_windows"}, // not a machine of the pool
		{ID: "b3", Amount: 5, Stop: true, Scope: "repository", Entity: "acme/api", Consumed: 5, ProductSKU: "actions"},
		{ID: "b4", Amount: 9, Stop: true, Scope: "organization", Entity: "acme", Consumed: 9, ProductSKU: "copilot"},
		{ID: "b5", Type: "SkuPricing", Amount: 9, Stop: true, Scope: "organization", Entity: "acme", Consumed: 9, ProductSKU: "actions_storage"},
		{ID: "b6", Amount: 9, Stop: true, Scope: "cost_center", Entity: "lab", Consumed: 9, ProductSKU: "actions"},
	}
	p := model.Pool{ID: 3, Name: "GitHub", Kind: model.PoolGitHub, AccountID: 61, Repo: "acme/relay", BudgetKind: model.BudgetGitHub}

	// Without "Administration: read" the app is told what to change.
	_, err := e.s.PoolUsage(ctx, p, 2026, time.November)
	if err == nil || !strings.Contains(err.Error(), "Administration: Read-only") ||
		!strings.Contains(err.Error(), "https://github.example/organizations/acme/settings/apps/ci-plane-runners-acme/permissions") {
		t.Fatalf("without the permission: %v", err)
	}

	e.gh.mu.Lock()
	e.gh.billingApps = true
	e.gh.mu.Unlock()
	u, err := e.s.PoolUsage(ctx, p, 2026, time.November)
	if err != nil {
		t.Fatal(err)
	}
	if u.Month != "2026-11" || u.Minutes != 170 || !near(u.GrossUSD, 1.14) || !near(u.NetUSD, 0.54) || !near(u.AccountNetUSD, 1.54) {
		t.Fatalf("usage %+v", u)
	}
	if len(u.Machines) != 2 || u.Machines[0].SKU != "Actions Linux" || u.Machines[0].Minutes != 150 || u.Machines[1].Minutes != 20 {
		t.Fatalf("machines %+v", u.Machines)
	}
	if len(u.Budgets) != 2 || u.Budgets[0].ID != "b1" || u.Budgets[1].ID != "b2" || !u.Budgets[1].UsedUp() || u.Budgets[0].UsedUp() {
		t.Fatalf("budgets %+v", u.Budgets)
	}
	if q := e.gh.usageQueries[len(e.gh.usageQueries)-1]; q != "year=2026&month=11" {
		t.Fatalf("query %q", q)
	}

	// An organisation of an enterprise: GitHub keeps the budgets from it.
	e.gh.mu.Lock()
	e.gh.fail["GET /organizations/acme/settings/billing/budgets"] = []int{400}
	e.gh.mu.Unlock()
	if _, err = e.s.PoolUsage(ctx, p, 2026, time.November); err == nil || !strings.Contains(err.Error(), "belongs to an enterprise") ||
		!strings.Contains(err.Error(), "choose another budget") {
		t.Fatalf("budgets of an enterprise's organisation: %v", err)
	}

	// Budgets are only read for a pool that follows them.
	p.BudgetKind = model.BudgetDollars
	before := e.gh.count("GET /organizations/acme/settings/billing/budgets")
	if u, err = e.s.PoolUsage(ctx, p, 2026, time.November); err != nil || u.Budgets != nil {
		t.Fatalf("dollars: %+v %v", u, err)
	}
	if e.gh.count("GET /organizations/acme/settings/billing/budgets") != before {
		t.Fatal("budgets read for a budget in dollars")
	}
}

func TestPoolUsageOfAPersonalAccountNeedsAToken(t *testing.T) {
	e := newEnv(t)
	acc := e.addRunnerApp(62, "jo", "ci-plane-runners-jo", 620, model.Repo{ID: 2, FullName: "jo/relay", Private: true})
	acc.OwnerType = "User"
	must(t, e.st.Tx(func(tx *store.Tx) error { return tx.SaveRunnerAccount(acc) }))
	e.gh.usage["users/jo"] = []usageItem{
		{Product: "actions", SKU: "actions_linux", Quantity: 30, UnitType: "Minutes", GrossAmount: 0.18, NetAmount: 0.18, RepositoryName: "jo/relay"},
	}
	p := model.Pool{ID: 4, Name: "GitHub", Kind: model.PoolGitHub, AccountID: 62, Repo: "jo/relay", BudgetKind: model.BudgetDollars}
	if _, err := e.s.PoolUsage(ctx, p, 2026, time.November); err == nil || !strings.Contains(err.Error(), "enter a token of jo with the permission Plan: read-only") {
		t.Fatalf("without a token: %v", err)
	}
	putToken := func(tok string) {
		must(t, e.st.Tx(func(tx *store.Tx) error { return e.box.Put(tx, api.UsageTokenName(62), []byte(tok)) }))
	}
	putToken("github_pat_old")
	e.gh.userToken = "github_pat_new"
	if _, err := e.s.PoolUsage(ctx, p, 2026, time.November); err == nil || !strings.Contains(err.Error(), "does not accept the token for the billing of jo") {
		t.Fatalf("a token that expired: %v", err)
	}
	putToken("github_pat_new")
	u, err := e.s.PoolUsage(ctx, p, 2026, time.November)
	if err != nil || u.Minutes != 30 || !near(u.NetUSD, 0.18) {
		t.Fatalf("with the token: %+v %v", u, err)
	}
	p.BudgetKind = model.BudgetGitHub
	if _, err := e.s.PoolUsage(ctx, p, 2026, time.November); err == nil || !strings.Contains(err.Error(), "budgets of a personal account") {
		t.Fatalf("budgets of a personal account: %v", err)
	}
	// Removing the account drops the token with it.
	if _, err := e.s.Remove(ctx, 62); err != nil {
		t.Fatal(err)
	}
	if tok, err := e.s.usageToken(62); err != nil || tok != "" {
		t.Fatalf("token kept: %q %v", tok, err)
	}
}

func near(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestBudgetsOfAnEnterprise(t *testing.T) {
	e := newEnv(t)
	e.addRunnerApp(61, "acme", "ci-plane-runners-acme", 610, model.Repo{ID: 1, FullName: "acme/relay", Private: true})
	e.gh.billingApps = true
	e.gh.usage["organizations/acme"] = []usageItem{
		{Product: "actions", SKU: "Actions Linux", Quantity: 100, UnitType: "Minutes", GrossAmount: 0.6, RepositoryName: "relay"},
	}
	e.gh.budgetList["enterprise/acme-inc"] = []ghBudget{
		{ID: "e1", Type: "ProductPricing", Amount: 100, Stop: true, Scope: "enterprise", Entity: "acme-inc", Consumed: 100, ProductSKU: "actions"},
		{ID: "e2", Type: "ProductPricing", Amount: 30, Stop: true, Scope: "organization", Entity: "acme", Consumed: 3, ProductSKU: "actions"},
		{ID: "e3", Type: "ProductPricing", Amount: 30, Stop: true, Scope: "organization", Entity: "other-org", Consumed: 30, ProductSKU: "actions"},
		{ID: "e4", Type: "SkuPricing", Amount: 5, Stop: true, Scope: "repository", Entity: "acme/relay", Consumed: 1, ProductSKU: "actions_linux"},
		{ID: "e5", Type: "ProductPricing", Amount: 9, Stop: true, Scope: "cost_center", Entity: "Lab", Consumed: 9, ProductSKU: "actions"},
		{ID: "e6", Type: "ProductPricing", Amount: 9, Stop: true, Scope: "cost_center", Entity: "Sales", Consumed: 9, ProductSKU: "actions"},
		{ID: "e7", Type: "ProductPricing", Amount: 9, Stop: true, Scope: "enterprise", Entity: "acme-inc", Consumed: 9, ProductSKU: "copilot"},
		{ID: "e8", Type: "ProductPricing", Amount: 9, Stop: true, Scope: "user", Entity: "", Consumed: 9, ProductSKU: "actions"},
	}
	e.gh.costCentres["organization/acme"] = []string{"Lab"}
	p := model.Pool{ID: 3, Name: "GitHub", Kind: model.PoolGitHub, AccountID: 61, Repo: "acme/relay", BudgetKind: model.BudgetGitHub, Enterprise: "acme-inc"}

	if _, err := e.s.PoolUsage(ctx, p, 2026, time.November); err == nil || !strings.Contains(err.Error(), "enter a token of an owner or billing manager of acme-inc") {
		t.Fatalf("without a token: %v", err)
	}
	put := func(tok string) {
		must(t, e.st.Tx(func(tx *store.Tx) error { return e.box.Put(tx, api.UsageTokenName(61), []byte(tok)) }))
	}
	put("ghp_old")
	e.gh.userToken = "ghp_owner"
	if _, err := e.s.PoolUsage(ctx, p, 2026, time.November); err == nil || !strings.Contains(err.Error(), "does not accept the token for the budgets of acme-inc") {
		t.Fatalf("a token that expired: %v", err)
	}
	put("ghp_owner")
	ids := func(u model.PoolUsage) string {
		var out []string
		for _, b := range u.Budgets {
			out = append(out, b.ID)
		}
		return strings.Join(out, " ")
	}
	u, err := e.s.PoolUsage(ctx, p, 2026, time.November)
	if err != nil || ids(u) != "e1 e2 e4 e5" || u.Minutes != 100 {
		t.Fatalf("budgets %q of %+v, %v", ids(u), u, err)
	}
	if !u.Budgets[0].UsedUp() || u.Budgets[1].UsedUp() {
		t.Fatalf("used up: %+v", u.Budgets)
	}
	// The organisation's own list is not asked: it has none to give.
	if n := e.gh.count("GET /organizations/acme/settings/billing/budgets"); n != 0 {
		t.Fatalf("organisation budgets asked %d times", n)
	}
	// A person who may not see cost centres sees the other budgets.
	e.gh.mu.Lock()
	e.gh.memberDenied = true
	e.gh.mu.Unlock()
	if u, err = e.s.PoolUsage(ctx, p, 2026, time.November); err != nil || ids(u) != "e1 e2 e4" {
		t.Fatalf("without cost centres: %q %v", ids(u), err)
	}
	// A name that is not the enterprise's.
	p.Enterprise = "acme"
	if _, err = e.s.PoolUsage(ctx, p, 2026, time.November); err == nil || !strings.Contains(err.Error(), "Check the name of the enterprise") ||
		!strings.Contains(err.Error(), "manage_billing:enterprise") {
		t.Fatalf("wrong enterprise: %v", err)
	}
	// The token never shows in an error.
	if strings.Contains(err.Error(), "ghp_") {
		t.Fatalf("token in the error: %v", err)
	}
}
