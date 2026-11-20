//go:build e2e

package e2e

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Removed tenant (#20, #21; E2 spec, sections 6 and 8): the gateway keeps
// answering 204, but the event does not reach Umami. Once reactivated, it
// reaches it again. The status changes directly in the database, as the
// operator action in the portal does (tested in
// apps/portal/test/isolation.test.ts); what matters here is the path from the
// gateway to Umami, with the SITE_CACHE_TTL cache.
func TestRemovedTenantIsDropped(t *testing.T) {
	token := umamiLogin(t)
	websiteID := umamiCreateWebsite(t, token)
	t.Cleanup(func() { umamiDo(t, token, http.MethodDelete, "/api/websites/"+websiteID, nil, nil) })

	db := connect(t, stellyticsDB)
	registerSite(t, db, websiteID)
	time.Sleep(siteCacheTTL + time.Second)
	start := time.Now().Add(-time.Minute)

	send := func(path string) {
		t.Helper()
		if code := sendEvent(t, websiteID, path); code != http.StatusNoContent {
			t.Fatalf("page view %s: status = %d, want 204", path, code)
		}
	}

	send("/active")
	waitPageviews(t, token, websiteID, start, 1)

	setTenantStatus(t, db, websiteID, "removed")
	time.Sleep(siteCacheTTL + time.Second)
	// Same response as success, to give no hint to whoever probes IDs.
	send("/removed")

	setTenantStatus(t, db, websiteID, "active")
	time.Sleep(siteCacheTTL + time.Second)
	send("/reactivated")

	// The two accepted events arrive; the removed tenant's one does not.
	waitPageviews(t, token, websiteID, start, 2)
	time.Sleep(3 * time.Second)
	if views := umamiPageviews(t, token, websiteID, start); views != 2 {
		t.Fatalf("pageviews = %d, want 2 (did the removed tenant's event reach Umami?)", views)
	}
}

func setTenantStatus(t *testing.T, db *pgx.Conn, websiteID, status string) {
	t.Helper()
	tag, err := db.Exec(context.Background(),
		`UPDATE tenant SET status = $2, status_changed_at = now()
		 WHERE id = (SELECT tenant_id FROM site WHERE umami_website_id = $1)`, websiteID, status)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("tenant of site %s not found", websiteID)
	}
}

// waitPageviews waits for Umami to count `want` page views; it fails if it goes
// past that.
func waitPageviews(t *testing.T, token, websiteID string, since time.Time, want int) {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for {
		views := umamiPageviews(t, token, websiteID, since)
		if views == want {
			return
		}
		if views > want {
			t.Fatalf("pageviews = %d, want %d", views, want)
		}
		if time.Now().After(deadline) {
			t.Fatalf("pageviews = %d after 90 s, want %d", views, want)
		}
		time.Sleep(time.Second)
	}
}
