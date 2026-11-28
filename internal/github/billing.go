package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

var _ engine.Billing = (*Service)(nil)

// usageItem is one line of GitHub's usage report: one product and SKU on
// one day in one repository.
type usageItem struct {
	Product          string  `json:"product"`
	SKU              string  `json:"sku"`
	Quantity         float64 `json:"quantity"`
	UnitType         string  `json:"unitType"`
	GrossAmount      float64 `json:"grossAmount"`
	DiscountAmount   float64 `json:"discountAmount"`
	NetAmount        float64 `json:"netAmount"`
	OrganizationName string  `json:"organizationName,omitempty"`
	RepositoryName   string  `json:"repositoryName"`
}

// minutes reports whether the item is Actions minutes: not storage, not
// another product.
func (it usageItem) minutes() bool {
	return strings.EqualFold(it.Product, "actions") && strings.HasPrefix(strings.ToLower(it.UnitType), "minute")
}

type ghBudget struct {
	ID         string  `json:"id"`
	Type       string  `json:"budget_type"` // ProductPricing or SkuPricing
	Amount     int     `json:"budget_amount"`
	Stop       bool    `json:"prevent_further_usage"`
	Scope      string  `json:"budget_scope"`
	Entity     string  `json:"budget_entity_name"`
	Consumed   float64 `json:"consumed_amount"`
	ProductSKU string  `json:"budget_product_sku"`
}

// maxBudgetPages bounds the budgets read: 100 a page.
const maxBudgetPages = 10

// PoolUsage implements engine.Billing. It reads the usage report of the
// owner of the pool's relay repository for one month: the report of the
// stable API, which has no filter by repository, so one request covers
// both the repository and the account as a whole. An organisation's report
// is read with the app of the pool (it needs "Administration: read"); a
// personal account's only with a token of the person, as GitHub lets no
// app read it.
func (s *Service) PoolUsage(ctx context.Context, p model.Pool, year int, month time.Month) (model.PoolUsage, error) {
	u := model.PoolUsage{Month: fmt.Sprintf("%04d-%02d", year, int(month))}
	if p.AccountID == 0 {
		return u, errors.New("this pool has no account for runners: edit it and choose its repository again, then CI-Plane can read its usage")
	}
	a, err := s.account(p.AccountID)
	if err != nil {
		return u, err
	}
	owner, _, _ := strings.Cut(p.Repo, "/")
	query := fmt.Sprintf("?year=%d&month=%d", year, int(month))
	var c call
	if a.IsOrg() {
		c = call{method: http.MethodGet, path: "/organizations/" + url.PathEscape(owner) + "/settings/billing/usage" + query, auth: authInstallation, account: a.ID}
	} else {
		tok, err := s.usageToken(a.ID)
		if err != nil {
			return u, err
		}
		if tok == "" {
			return u, fmt.Errorf("GitHub lets no app read the billing of a personal account: edit the pool and enter a token of %s with the permission Plan: read-only", owner)
		}
		c = call{method: http.MethodGet, path: "/users/" + url.PathEscape(owner) + "/settings/billing/usage" + query, token: tok}
	}
	var rep struct {
		UsageItems []usageItem `json:"usageItems"`
	}
	if _, err := s.getJSON(ctx, c, &rep); err != nil {
		return u, s.billingError(a, owner, err)
	}
	machines := map[string]*model.MachineUsage{}
	for _, it := range rep.UsageItems {
		if !it.minutes() {
			continue
		}
		u.AccountNetUSD += it.NetAmount
		if !sameRepo(it.RepositoryName, p.Repo) {
			continue
		}
		u.Minutes += it.Quantity
		u.GrossUSD += it.GrossAmount
		u.NetUSD += it.NetAmount
		m := machines[it.SKU]
		if m == nil {
			m = &model.MachineUsage{SKU: it.SKU}
			machines[it.SKU] = m
		}
		m.Minutes += it.Quantity
		m.GrossUSD += it.GrossAmount
		m.NetUSD += it.NetAmount
	}
	for _, m := range machines {
		u.Machines = append(u.Machines, *m)
	}
	sort.Slice(u.Machines, func(i, j int) bool {
		x, y := u.Machines[i], u.Machines[j]
		return x.Minutes > y.Minutes || x.Minutes == y.Minutes && x.SKU < y.SKU
	})
	// What the plan includes, and how much of it is used. The budgets of
	// an organisation name it as its profile does, not by its login.
	names := []string{owner}
	display, plan := s.ownerPlan(ctx, a, owner)
	if display != "" {
		names = append(names, display)
	}
	u.Plan, u.IncludedMin = plan, model.IncludedMinutes(plan)
	items := rep.UsageItems
	if p.Budget() == model.BudgetGitHub {
		if !a.IsOrg() {
			return u, errors.New("GitHub has no way to read the budgets of a personal account: choose another kind of budget for this pool")
		}
		skus := map[string]bool{}
		for _, m := range u.Machines {
			skus[skuKey(m.SKU)] = true
		}
		if p.Enterprise != "" {
			if u.Budgets, err = s.enterpriseBudgets(ctx, a, p.Enterprise, names, p.Repo, skus); err != nil {
				return u, err
			}
			// The included minutes are the enterprise's, shared by its
			// organisations. A person who may not see its usage sees that
			// of the organisation only.
			if all, err := s.enterpriseUsage(ctx, a, p.Enterprise, query); err == nil {
				items = all
			} else if statusOf(err) == 0 {
				return u, err
			}
		} else if u.Budgets, err = s.budgets(ctx, a, names, p.Repo, skus); err != nil {
			return u, err
		}
	}
	if u.IncludedMin > 0 {
		if u.IncludedUsedMin, err = s.includedUsed(ctx, a, owner, items); err != nil {
			return u, err
		}
	}
	return u, nil
}

// ownerPlan reads the name an owner shows on its profile and the name of
// its plan; "" for what GitHub does not tell.
func (s *Service) ownerPlan(ctx context.Context, a model.Account, owner string) (display, plan string) {
	var o struct {
		Login string `json:"login"`
		Name  string `json:"name"`
		Plan  struct {
			Name string `json:"name"`
		} `json:"plan"`
	}
	c := call{method: http.MethodGet, path: "/orgs/" + url.PathEscape(owner), auth: authInstallation, account: a.ID, conditional: true}
	if !a.IsOrg() {
		// Only the person sees the plan of a personal account.
		tok, err := s.usageToken(a.ID)
		if err != nil || tok == "" {
			return "", ""
		}
		c = call{method: http.MethodGet, path: "/user", token: tok}
	}
	if _, err := s.getJSON(ctx, c, &o); err != nil || !strings.EqualFold(o.Login, owner) {
		return "", ""
	}
	return o.Name, o.Plan.Name
}

// enterpriseUsage reads the usage report of an enterprise for a month,
// with the token of the person.
func (s *Service) enterpriseUsage(ctx context.Context, a model.Account, enterprise, query string) ([]usageItem, error) {
	tok, err := s.usageToken(a.ID)
	if err != nil {
		return nil, err
	}
	var rep struct {
		UsageItems []usageItem `json:"usageItems"`
	}
	c := call{method: http.MethodGet, path: "/enterprises/" + url.PathEscape(enterprise) + "/settings/billing/usage" + query, token: tok}
	if _, err := s.getJSON(ctx, c, &rep); err != nil {
		return nil, err
	}
	return rep.UsageItems, nil
}

// includedUsed is how many of the minutes a plan includes the items of a
// usage report used up: those of private repositories that GitHub
// discounted instead of billing them, Windows minutes twice and macOS
// minutes ten times, as GitHub counts them. Public repositories run free of
// charge and use none; a repository the app cannot see counts as private.
func (s *Service) includedUsed(ctx context.Context, a model.Account, owner string, items []usageItem) (float64, error) {
	repos := map[string]float64{}
	for _, it := range items {
		if !it.minutes() || it.GrossAmount <= 0 || it.DiscountAmount <= 0 {
			continue // billed in full, like larger runners: not of the included minutes
		}
		name := it.RepositoryName
		if !strings.Contains(name, "/") {
			org := it.OrganizationName
			if org == "" {
				org = owner
			}
			name = org + "/" + name
		}
		weight := 1.0
		switch sku := skuKey(it.SKU); {
		case strings.Contains(sku, "windows"):
			weight = 2
		case strings.Contains(sku, "macos"):
			weight = 10
		}
		repos[name] += it.Quantity * min(it.DiscountAmount/it.GrossAmount, 1) * weight
	}
	used := 0.0
	for name, minutes := range repos {
		public, err := s.repoPublic(ctx, a, name)
		if err != nil {
			return 0, err
		}
		if !public {
			used += minutes
		}
	}
	return used, nil
}

// repoPublic reports whether a repository (owner/name) is public. One that
// the app cannot see, or that has no name, is not.
func (s *Service) repoPublic(ctx context.Context, a model.Account, full string) (bool, error) {
	path, err := repoPath(full)
	if err != nil {
		return false, nil
	}
	var r struct {
		Private bool `json:"private"`
	}
	_, err = s.getJSON(ctx, call{method: http.MethodGet, path: path, auth: authInstallation, account: a.ID, conditional: true}, &r)
	switch st := statusOf(err); {
	case err == nil:
		return !r.Private, nil
	case st == http.StatusNotFound || st == http.StatusForbidden || st == http.StatusMovedPermanently:
		return false, nil
	}
	return false, err
}

// budgets reads the budgets of an organisation that cover the Actions
// minutes of repo: those of the organisation and of the repository; for
// all of Actions, or for a SKU among skus, the machines the repository used
// this month. Budgets of cost centres are left out, as CI-Plane cannot see
// here what they cover.
func (s *Service) budgets(ctx context.Context, a model.Account, orgs []string, repo string, skus map[string]bool) ([]model.GitHubBudget, error) {
	org := orgs[0]
	list, err := s.budgetPages(ctx, func(page int) call {
		path := fmt.Sprintf("/organizations/%s/settings/billing/budgets?per_page=100&page=%d", url.PathEscape(org), page)
		return call{method: http.MethodGet, path: path, auth: authInstallation, account: a.ID}
	})
	if err != nil {
		// What GitHub answers for an organisation whose billing an
		// enterprise keeps: its budgets are the enterprise's.
		if statusOf(err) == http.StatusBadRequest {
			return nil, fmt.Errorf("GitHub does not hand out the budgets of %s (it answers: %s). That is so when the organisation belongs to an enterprise, "+
				"which keeps the budgets. Edit the pool and enter the enterprise and a token that reads its budgets, or choose another budget", org, strings.TrimRight(messageOfErr(err), "."))
		}
		return nil, s.billingError(a, org, err)
	}
	return coveringBudgets(list, orgs, repo, skus, nil), nil
}

// enterpriseBudgets reads the budgets of the enterprise an organisation
// belongs to that cover the Actions minutes of repo: those of the
// enterprise, of the organisation, of the repository, and of the cost
// centres either of them is in. GitHub shows them to a person only (an
// owner or billing manager of the enterprise; an owner of the organisation
// sees those of the organisation and its repositories), so they are read
// with the token entered in the pool.
func (s *Service) enterpriseBudgets(ctx context.Context, a model.Account, enterprise string, orgs []string, repo string, skus map[string]bool) ([]model.GitHubBudget, error) {
	org := orgs[0]
	tok, err := s.usageToken(a.ID)
	if err != nil {
		return nil, err
	}
	if tok == "" {
		return nil, fmt.Errorf("GitHub shows the budgets of an enterprise to a person only: edit the pool and enter a token of an owner or billing manager of %s", enterprise)
	}
	base := "/enterprises/" + url.PathEscape(enterprise) + "/settings/billing"
	explain := func(err error) error {
		switch statusOf(err) {
		case http.StatusUnauthorized:
			return fmt.Errorf("GitHub does not accept the token for the budgets of %s any more; it may have expired. Edit the pool and enter a new one", enterprise)
		case http.StatusForbidden, http.StatusNotFound:
			return fmt.Errorf("the token may not read the budgets of the enterprise %s (GitHub answers: %s). Check the name of the enterprise, as in github.com/enterprises/NAME, "+
				"and enter a classic token of one of its owners or billing managers with the scope manage_billing:enterprise; "+
				"if %s asks for single sign-on, authorise the token for it", enterprise, strings.TrimRight(messageOfErr(err), "."), org)
		}
		return err
	}
	list, err := s.budgetPages(ctx, func(page int) call {
		return call{method: http.MethodGet, path: fmt.Sprintf("%s/budgets?per_page=100&page=%d", base, page), token: tok}
	})
	if err != nil {
		return nil, explain(err)
	}
	// The cost centres the organisation and the repository are in. A person
	// who may not see them sees no budget of a cost centre either.
	centres := map[string]bool{}
	for kind, name := range map[string]string{"organization": org, "repository": repo} {
		var m struct {
			Memberships []struct {
				CostCenter struct {
					Name string `json:"name"`
				} `json:"cost_center"`
			} `json:"memberships"`
		}
		path := base + "/cost-centers/memberships?resource_type=" + kind + "&name=" + url.QueryEscape(name)
		if _, err := s.getJSON(ctx, call{method: http.MethodGet, path: path, token: tok}, &m); err != nil {
			if statusOf(err) == 0 {
				return nil, err // the network, not an answer
			}
			continue
		}
		for _, x := range m.Memberships {
			centres[strings.ToLower(x.CostCenter.Name)] = true
		}
	}
	return coveringBudgets(list, orgs, repo, skus, centres), nil
}

// budgetPages reads every page of a list of budgets.
func (s *Service) budgetPages(ctx context.Context, req func(page int) call) ([]ghBudget, error) {
	var all []ghBudget
	for page := 1; page <= maxBudgetPages; page++ {
		var resp struct {
			Budgets []ghBudget `json:"budgets"`
			HasNext bool       `json:"has_next_page"`
		}
		if _, err := s.getJSON(ctx, req(page), &resp); err != nil {
			return nil, err
		}
		all = append(all, resp.Budgets...)
		if !resp.HasNext || len(resp.Budgets) == 0 {
			break
		}
	}
	return all, nil
}

// coveringBudgets are the budgets among list that cover the Actions
// minutes of repo, a repository of the organisation orgs name (its login,
// and its name as its profile shows it: budgets use either): for all of
// Actions, or for a SKU among skus; of the enterprise, the organisation,
// the repository, or a cost centre among centres (by name, in lower case).
func coveringBudgets(list []ghBudget, orgs []string, repo string, skus, centres map[string]bool) []model.GitHubBudget {
	isOrg := func(name string) bool {
		for _, o := range orgs {
			if strings.EqualFold(name, o) {
				return true
			}
		}
		return name == ""
	}
	out := []model.GitHubBudget{}
	for _, b := range list {
		sku := skuKey(b.ProductSKU)
		switch {
		case strings.EqualFold(b.Type, "SkuPricing"):
			if !skus[sku] {
				continue // another machine, or storage
			}
		case sku != "actions":
			continue // another product
		}
		switch strings.ToLower(b.Scope) {
		case "enterprise":
		case "organization":
			if !isOrg(b.Entity) {
				continue
			}
		case "repository":
			if !sameRepo(b.Entity, repo) {
				continue
			}
		case "cost_center":
			if !centres[strings.ToLower(b.Entity)] {
				continue
			}
		default:
			continue
		}
		out = append(out, model.GitHubBudget{ID: b.ID, Scope: strings.ToLower(b.Scope), Entity: b.Entity, SKU: b.ProductSKU,
			AmountUSD: b.Amount, ConsumedUSD: b.Consumed, Stop: b.Stop})
	}
	return out
}

// skuKey is a SKU as budgets name it (actions_linux), also for one the
// usage report names in words (Actions Linux).
func skuKey(sku string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(sku)), " ", "_")
}

// messageOfErr is GitHub's own message in an error of the API.
func messageOfErr(err error) string {
	var ae *apiError
	if errors.As(err, &ae) && ae.Message != "" {
		return ae.Message
	}
	return err.Error()
}

// sameRepo reports whether a repository as the billing names it, with or
// without its owner, is repo (owner/name).
func sameRepo(name, repo string) bool {
	if name == "" {
		return false
	}
	_, short, _ := strings.Cut(repo, "/")
	return strings.EqualFold(name, repo) || !strings.Contains(name, "/") && strings.EqualFold(name, short)
}

// usageToken is the token of a person that reads the billing of the
// personal account of an app; "" if none was entered.
func (s *Service) usageToken(accountID int64) (string, error) {
	var tok []byte
	err := s.st.View(func(tx *store.Tx) error {
		var err error
		tok, err = s.box.Get(tx, api.UsageTokenName(accountID))
		if errors.Is(err, store.ErrNotFound) {
			err = nil
		}
		return err
	})
	return strings.TrimSpace(string(tok)), err
}

// billingError says what to do when GitHub refuses to show the billing.
func (s *Service) billingError(a model.Account, owner string, err error) error {
	st := statusOf(err)
	switch {
	case st == 0:
		return err // network, rate limit: passes by itself
	case a.IsOrg() && (st == http.StatusForbidden || st == http.StatusNotFound):
		return fmt.Errorf("the app %s may not read the billing of %s. On GitHub, give it the organisation permission Administration: Read-only (%s), "+
			"then accept the new permission under the organisation's Settings, GitHub Apps. Only GitHub-hosted runners of organisations "+
			"on GitHub's current billing have their usage there", a.Slug, owner, s.permissionsURL(a))
	case !a.IsOrg() && st == http.StatusUnauthorized:
		return fmt.Errorf("GitHub does not accept the token for the billing of %s any more; it may have expired. Edit the pool and enter a new one", owner)
	case !a.IsOrg() && (st == http.StatusForbidden || st == http.StatusNotFound):
		return fmt.Errorf("the token may not read the billing of %s. Create a fine-grained token of %s with the account permission Plan: read-only, "+
			"and enter it in the pool", owner, owner)
	}
	return err
}

// permissionsURL is the page where the owner of an app changes its
// permissions.
func (s *Service) permissionsURL(a model.Account) string {
	if a.IsOrg() {
		return s.WebURL + "/organizations/" + url.PathEscape(a.Owner) + "/settings/apps/" + url.PathEscape(a.Slug) + "/permissions"
	}
	return s.WebURL + "/settings/apps/" + url.PathEscape(a.Slug) + "/permissions"
}
