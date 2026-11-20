//go:build e2e

// End-to-end test against the Docker Compose environment:
//
//	docker compose -f compose.yaml -f infra/compose/umami-port.yaml up -d --build --wait
//	cd services && go test -tags e2e ./ingest-web/e2e/...
//
// It creates a website in Umami through the API and an active tenant with that
// site in the stellytics database (what shows up in ingest_site), sends a page
// view to the gateway and checks that it shows up in Umami, and that the event
// sent before the registration does not. The URLs can be overridden with
// GATEWAY_URL, UMAMI_URL, STELLYTICS_DATABASE_URL and UMAMI_DATABASE_URL. The
// privacy test (privacy_test.go) requires the gateway to trust the
// X-Forwarded-For of the test's connection (INGEST_TRUSTED_PROXIES).
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/romulospl/stellytics/services/ingest-web/internal/proof"
)

const browserUA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

var (
	gatewayURL   = env("GATEWAY_URL", "http://127.0.0.1:3002")
	umamiURL     = env("UMAMI_URL", "http://127.0.0.1:3001")
	stellyticsDB = env("STELLYTICS_DATABASE_URL", "postgresql://stellytics:stellytics@127.0.0.1:5432/stellytics")
	umamiDB      = env("UMAMI_DATABASE_URL", "postgresql://umami:umami@127.0.0.1:5432/umami")
)

// siteCacheTTL is the gateway's SITE_CACHE_TTL in Compose.
const siteCacheTTL = 5 * time.Second

func TestEventReachesUmami(t *testing.T) {
	ctx := context.Background()

	resp, err := http.Get(gatewayURL + "/healthz")
	if err != nil {
		t.Fatalf("gateway down: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/healthz = %d", resp.StatusCode)
	}

	token := umamiLogin(t)
	websiteID := umamiCreateWebsite(t, token)
	t.Cleanup(func() { umamiDo(t, token, http.MethodDelete, "/api/websites/"+websiteID, nil, nil) })

	db, err := pgx.Connect(ctx, stellyticsDB)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)

	// Before the registration, the gateway answers as if it accepted (E2 spec,
	// section 6), but drops: the pageview must not reach Umami.
	if code := sendEvent(t, websiteID, "/before"); code != http.StatusNoContent {
		t.Fatalf("site not in ingest_site: status = %d, want 204", code)
	}

	registerSite(t, db, websiteID)

	// The negative answer stays in the gateway's cache for SITE_CACHE_TTL (5 s
	// in Compose).
	time.Sleep(siteCacheTTL + time.Second)
	start := time.Now().Add(-time.Minute)
	deadline := time.Now().Add(90 * time.Second)
	if code := sendEvent(t, websiteID, "/docs/e2e"); code != http.StatusNoContent {
		t.Fatalf("valid event: status = %d, want 204", code)
	}

	for {
		views := umamiPageviews(t, token, websiteID, start)
		if views == 1 {
			return
		}
		if views > 1 {
			t.Fatalf("pageviews = %d, want 1 (did the refused event reach Umami?)", views)
		}
		if time.Now().After(deadline) {
			t.Fatal("the page view did not show up in Umami")
		}
		time.Sleep(time.Second)
	}
}

// registerSite creates an active tenant with the site in the stellytics
// database, which puts it in ingest_site with accepts_ingest true.
func registerSite(t *testing.T, db *pgx.Conn, websiteID string) {
	t.Helper()
	ctx := context.Background()
	var tenantID string
	if err := db.QueryRow(ctx,
		`INSERT INTO tenant (name, slug) VALUES ($1, $1) RETURNING id`, "e2e-"+websiteID,
	).Scan(&tenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO site (tenant_id, name, domain, umami_website_id)
		VALUES ($1, 'e2e', 'e2e.example', $2)`, tenantID, websiteID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = db.Exec(ctx, `DELETE FROM site WHERE tenant_id = $1`, tenantID)
		_, _ = db.Exec(ctx, `DELETE FROM tenant WHERE id = $1`, tenantID)
	})
}

// sendEvent sends a page view to the gateway; hdr are extra header pairs.
func sendEvent(t *testing.T, websiteID, path string, hdr ...string) int {
	t.Helper()
	token, nonce := solveChallenge(t, websiteID)
	body := fmt.Sprintf(`{"type":"event","p":{"t":%q,"n":%q},"payload":{"website":%q,"hostname":"e2e.example","url":%q,`+
		`"title":"e2e","language":"de-DE","screen":"1920x1080"}}`, token, nonce, websiteID, path)
	req, _ := http.NewRequest(http.MethodPost, gatewayURL+"/e", strings.NewReader(body))
	req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	req.Header.Set("User-Agent", browserUA)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

// solveChallenge requests the challenge on GET /c and solves it, as the script
// does (#25).
func solveChallenge(t *testing.T, websiteID string) (token, nonce string) {
	t.Helper()
	resp, err := http.Get(gatewayURL + "/c?s=" + websiteID)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var c proof.Challenge
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&c) != nil {
		t.Fatalf("GET /c: status %d", resp.StatusCode)
	}
	return c.Token, proof.Solve(c.Token, c.Bits)
}

func umamiLogin(t *testing.T) string {
	t.Helper()
	var out struct {
		Token string `json:"token"`
	}
	umamiDo(t, "", http.MethodPost, "/api/auth/login",
		map[string]string{"username": env("UMAMI_USER", "admin"), "password": env("UMAMI_PASSWORD", "umami")}, &out)
	if out.Token == "" {
		t.Fatal("Umami login without a token")
	}
	return out.Token
}

func umamiCreateWebsite(t *testing.T, token string) string {
	t.Helper()
	var out struct {
		ID string `json:"id"`
	}
	name := "e2e-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	umamiDo(t, token, http.MethodPost, "/api/websites", map[string]string{"name": name, "domain": "e2e.example"}, &out)
	if out.ID == "" {
		t.Fatal("Umami did not return the website id")
	}
	return out.ID
}

func umamiPageviews(t *testing.T, token, websiteID string, since time.Time) int {
	t.Helper()
	var out map[string]json.RawMessage
	path := fmt.Sprintf("/api/websites/%s/stats?startAt=%d&endAt=%d",
		websiteID, since.UnixMilli(), time.Now().Add(time.Minute).UnixMilli())
	umamiDo(t, token, http.MethodGet, path, nil, &out)
	raw, ok := out["pageviews"]
	if !ok {
		t.Fatalf("stats without pageviews: %v", out)
	}
	// v3 returns a number; older versions, {"value": n}.
	var n int
	if err := json.Unmarshal(raw, &n); err == nil {
		return n
	}
	var v struct{ Value int }
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unexpected pageviews: %s", raw)
	}
	return v.Value
}

func umamiDo(t *testing.T, token, method, path string, in, out any) {
	t.Helper()
	var body bytes.Buffer
	if in != nil {
		_ = json.NewEncoder(&body).Encode(in)
	}
	req, _ := http.NewRequest(method, umamiURL+path, &body)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		t.Fatalf("%s %s = %d", method, path, resp.StatusCode)
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
	}
}

// TestCustomEventReachesUmami sends a custom event (#50) and checks in Umami's
// database the name and the properties, and that the full IP was not written.
func TestCustomEventReachesUmami(t *testing.T) {
	ctx := context.Background()
	token := umamiLogin(t)
	websiteID := umamiCreateWebsite(t, token)
	t.Cleanup(func() { umamiDo(t, token, http.MethodDelete, "/api/websites/"+websiteID, nil, nil) })

	db, err := pgx.Connect(ctx, stellyticsDB)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)
	registerSite(t, db, websiteID)
	time.Sleep(siteCacheTTL + time.Second)

	body := func(extra string) string {
		tok, nonce := solveChallenge(t, websiteID)
		return fmt.Sprintf(`{"type":"event","p":{"t":%q,"n":%q},"payload":{"website":%q,"hostname":"e2e.example","url":"/pricing",`+
			`"title":"e2e","language":"de-DE","screen":"1920x1080",%s}}`, tok, nonce, websiteID, extra)
	}
	post := func(b string) int {
		req, _ := http.NewRequest(http.MethodPost, gatewayURL+"/e", strings.NewReader(b))
		req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
		req.Header.Set("User-Agent", browserUA)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if code := post(body(`"name":"signup_clicked","data":{"plan":"pro","seats":3,"trial":true}`)); code != http.StatusNoContent {
		t.Fatalf("custom event: status = %d, want 204", code)
	}
	if code := post(body(`"name":"bad name"`)); code != http.StatusBadRequest {
		t.Fatalf("invalid name: status = %d, want 400", code)
	}

	udb, err := pgx.Connect(ctx, umamiDB)
	if err != nil {
		t.Fatal(err)
	}
	defer udb.Close(ctx)

	deadline := time.Now().Add(90 * time.Second)
	for {
		rows, err := udb.Query(ctx, `SELECT e.event_name, d.data_key, d.string_value, d.number_value::text
			FROM website_event e JOIN event_data d ON d.website_event_id = e.event_id
			WHERE e.website_id = $1 AND e.event_name IS NOT NULL ORDER BY d.data_key`, websiteID)
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]string{}
		for rows.Next() {
			var name, key string
			var s, n *string
			if err := rows.Scan(&name, &key, &s, &n); err != nil {
				t.Fatal(err)
			}
			if name != "signup_clicked" {
				t.Fatalf("event_name = %q", name)
			}
			switch {
			case s != nil:
				got[key] = *s
			case n != nil:
				got[key] = *n
			}
		}
		rows.Close()
		if got["plan"] == "pro" && got["seats"] != "" {
			t.Logf("properties in Umami: %v", got)
			if got["plan"] != "pro" || !strings.HasPrefix(got["seats"], "3") {
				t.Fatalf("properties = %v", got)
			}
			var n int
			if err := udb.QueryRow(ctx, `SELECT count(*) FROM website_event WHERE website_id = $1 AND event_name IS NOT NULL`, websiteID).Scan(&n); err != nil || n != 1 {
				t.Fatalf("custom events = %d (err %v), want 1", n, err)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the custom event did not show up in Umami (seen: %v)", got)
		}
		time.Sleep(time.Second)
	}
}

// TestWalletEventsReachUmami sends the two events that
// window.stellytics.wallets (script v1.3.0, #50) produces and checks in Umami's
// database that wallet_selected carries only wallet=freighter and that
// wallet_disconnected carries no property.
func TestWalletEventsReachUmami(t *testing.T) {
	ctx := context.Background()
	token := umamiLogin(t)
	websiteID := umamiCreateWebsite(t, token)
	t.Cleanup(func() { umamiDo(t, token, http.MethodDelete, "/api/websites/"+websiteID, nil, nil) })

	db, err := pgx.Connect(ctx, stellyticsDB)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)
	registerSite(t, db, websiteID)
	time.Sleep(siteCacheTTL + time.Second)

	for _, extra := range []string{
		`"name":"wallet_selected","data":{"wallet":"freighter"}`,
		`"name":"wallet_disconnected"`,
	} {
		tok, nonce := solveChallenge(t, websiteID)
		b := fmt.Sprintf(`{"type":"event","p":{"t":%q,"n":%q},"payload":{"website":%q,"hostname":"e2e.example","url":"/connect",`+
			`"title":"e2e","language":"de-DE","screen":"1920x1080",%s}}`, tok, nonce, websiteID, extra)
		req, _ := http.NewRequest(http.MethodPost, gatewayURL+"/e", strings.NewReader(b))
		req.Header.Set("Content-Type", "text/plain")
		req.Header.Set("User-Agent", browserUA)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("%s: status = %d, want 204", extra, resp.StatusCode)
		}
	}

	udb, err := pgx.Connect(ctx, umamiDB)
	if err != nil {
		t.Fatal(err)
	}
	defer udb.Close(ctx)

	deadline := time.Now().Add(90 * time.Second)
	for {
		rows, err := udb.Query(ctx, `SELECT e.event_name, coalesce(d.data_key, ''), coalesce(d.string_value, '')
			FROM website_event e LEFT JOIN event_data d ON d.website_event_id = e.event_id
			WHERE e.website_id = $1 AND e.event_name IS NOT NULL ORDER BY e.event_name, d.data_key`, websiteID)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for rows.Next() {
			var name, key, val string
			if err := rows.Scan(&name, &key, &val); err != nil {
				t.Fatal(err)
			}
			got = append(got, name+"|"+key+"="+val)
		}
		rows.Close()
		if len(got) == 2 {
			t.Logf("events in Umami: %v", got)
			if got[0] != "wallet_disconnected|=" || got[1] != "wallet_selected|wallet=freighter" {
				t.Fatalf("events = %v", got)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the wallet events did not show up in Umami (seen: %v)", got)
		}
		time.Sleep(time.Second)
	}
}
