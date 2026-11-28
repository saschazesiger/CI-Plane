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
	Product        string  `json:"product"`
	SKU            string  `json:"sku"`
	Quantity       float64 `json:"quantity"`
	UnitType       string  `json:"unitType"`
	GrossAmount    float64 `json:"grossAmount"`
	NetAmount      float64 `json:"netAmount"`
	RepositoryName string  `json:"repositoryName"`
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
		if !strings.EqualFold(it.Product, "actions") || !strings.HasPrefix(strings.ToLower(it.UnitType), "minute") {
			continue // storage, other products
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
	if p.Budget() == model.BudgetGitHub {
		if !a.IsOrg() {
			return u, errors.New("GitHub has no way to read the budgets of a personal account: choose another kind of budget for this pool")
		}
		skus := map[string]bool{}
		for _, m := range u.Machines {
			skus[skuKey(m.SKU)] = true
		}
		if u.Budgets, err = s.budgets(ctx, a, owner, p.Repo, skus); err != nil {
			return u, err
		}
	}
	return u, nil
}

// budgets reads the budgets of an organisation that cover the Actions
// minutes of repo: those of the organisation, of its enterprise, and of the
// repository; for all of Actions, or for a SKU among skus, the machines the
// repository used this month. Budgets of cost centres are left out, as
// CI-Plane cannot see what they cover.
func (s *Service) budgets(ctx context.Context, a model.Account, org, repo string, skus map[string]bool) ([]model.GitHubBudget, error) {
	out := []model.GitHubBudget{}
	for page := 1; page <= maxBudgetPages; page++ {
		var resp struct {
			Budgets []ghBudget `json:"budgets"`
			HasNext bool       `json:"has_next_page"`
		}
		path := fmt.Sprintf("/organizations/%s/settings/billing/budgets?per_page=100&page=%d", url.PathEscape(org), page)
		if _, err := s.getJSON(ctx, call{method: http.MethodGet, path: path, auth: authInstallation, account: a.ID}, &resp); err != nil {
			// What GitHub answers for an organisation whose billing an
			// enterprise keeps: its budgets are the enterprise's.
			if statusOf(err) == http.StatusBadRequest {
				return nil, fmt.Errorf("GitHub does not hand out the budgets of %s (it answers: %s). That is so when the organisation belongs to an enterprise, "+
					"which keeps the budgets. Edit the pool and choose another budget: dollars, or only the included minutes", org, strings.TrimRight(messageOfErr(err), "."))
			}
			return nil, s.billingError(a, org, err)
		}
		for _, b := range resp.Budgets {
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
			case "organization", "enterprise":
			case "repository":
				if !sameRepo(b.Entity, repo) {
					continue
				}
			default:
				continue
			}
			out = append(out, model.GitHubBudget{ID: b.ID, Scope: strings.ToLower(b.Scope), Entity: b.Entity, SKU: b.ProductSKU,
				AmountUSD: b.Amount, ConsumedUSD: b.Consumed, Stop: b.Stop})
		}
		if !resp.HasNext || len(resp.Budgets) == 0 {
			break
		}
	}
	return out, nil
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
