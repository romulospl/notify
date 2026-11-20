//go:build e2e

package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Session recording (replays) and heatmaps of Umami 3.4.1 (#62, docs/umami.md):
// they are only written through the /api/record route, and only for a website
// with recorder_enabled. The test creates the site the way the portal does,
// sends real page views through the gateway, tries to record a replay and a
// heatmap through the gateway and directly in Umami, and checks that the
// session_replay, session_replay_saved and heatmap_event tables stay empty.
func TestRecorderRecordsNothing(t *testing.T) {
	ctx := context.Background()

	token := umamiLogin(t)
	websiteID := umamiCreateWebsite(t, token)
	t.Cleanup(func() { umamiDo(t, token, http.MethodDelete, "/api/websites/"+websiteID, nil, nil) })

	var site struct {
		RecorderEnabled bool            `json:"recorderEnabled"`
		ReplayConfig    *map[string]any `json:"replayConfig"`
	}
	umamiDo(t, token, http.MethodGet, "/api/websites/"+websiteID, nil, &site)
	if site.RecorderEnabled || site.ReplayConfig != nil {
		t.Fatalf("new site with recording on: recorderEnabled=%v replayConfig=%v",
			site.RecorderEnabled, site.ReplayConfig)
	}

	registerSite(t, connect(t, stellyticsDB), websiteID)
	time.Sleep(siteCacheTTL + time.Second)
	start := time.Now().Add(-time.Minute)

	for _, path := range []string{"/", "/docs", "/docs/replay"} {
		if code := sendEvent(t, websiteID, path); code != http.StatusNoContent {
			t.Fatalf("page view %s: status = %d, want 204", path, code)
		}
	}

	// The gateway only has /e, /c, /s/ and /healthz: the recording route does
	// not exist in it.
	for _, path := range []string{"/api/record", "/record"} {
		if code := post(t, gatewayURL+path, recordBody(websiteID), nil); code != http.StatusNotFound {
			t.Errorf("gateway POST %s = %d, want 404", path, code)
		}
	}

	// Even with direct access to Umami (internal network only), the site does
	// not record: /api/send returns the session token that /api/record
	// requires.
	cache := umamiSessionToken(t, websiteID)
	for _, body := range []string{recordBody(websiteID), heatmapBody(websiteID)} {
		var out map[string]any
		code := post(t, umamiURL+"/api/record", body, map[string]string{"x-umami-cache": cache}, &out)
		if code != http.StatusOK || out["ok"] != false || out["reason"] != "recorder_disabled" {
			t.Errorf("Umami /api/record = %d %v, want 200 recorder_disabled", code, out)
		}
	}

	deadline := time.Now().Add(90 * time.Second)
	for umamiPageviews(t, token, websiteID, start) < 3 {
		if time.Now().After(deadline) {
			t.Fatal("the page views did not show up in Umami")
		}
		time.Sleep(time.Second)
	}

	db, err := pgx.Connect(ctx, umamiDB)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(ctx)
	// Only the test's site: a local volume may have other sites with recording.
	for _, q := range []string{
		`SELECT count(*) FROM session_replay WHERE website_id = $1`,
		`SELECT count(*) FROM session_replay_saved WHERE website_id = $1`,
		`SELECT count(*) FROM heatmap_event WHERE website_id = $1`,
		`SELECT count(*) FROM website WHERE website_id = $1 AND (recorder_enabled OR replay_config IS NOT NULL)`,
	} {
		var n int
		if err := db.QueryRow(ctx, q, websiteID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Errorf("%s = %d, want 0", q, n)
		}
	}
}

// umamiSessionToken sends a page view directly to Umami's /api/send and returns
// the session token (cache) from the response.
func umamiSessionToken(t *testing.T, websiteID string) string {
	t.Helper()
	body := fmt.Sprintf(`{"type":"event","payload":{"website":%q,"hostname":"e2e.example","url":"/direct",`+
		`"language":"de-DE","screen":"1920x1080"}}`, websiteID)
	var out struct {
		Cache string `json:"cache"`
	}
	if code := post(t, umamiURL+"/api/send", body, nil, &out); code != http.StatusOK || out.Cache == "" {
		t.Fatalf("Umami /api/send = %d, cache %q", code, out.Cache)
	}
	return out.Cache
}

func recordBody(websiteID string) string {
	return fmt.Sprintf(`{"type":"record","payload":{"website":%q,"events":[{"type":4,"timestamp":%d,`+
		`"data":{"href":"https://e2e.example/","width":1920,"height":1080}}]}}`, websiteID, time.Now().UnixMilli())
}

func heatmapBody(websiteID string) string {
	return fmt.Sprintf(`{"type":"heatmap","payload":{"website":%q,"events":[`+
		`{"type":"click","url":"https://e2e.example/","x":10,"y":20,"pageW":1920,"pageH":3000},`+
		`{"type":"scroll","url":"https://e2e.example/","scrollPct":50}]}}`, websiteID)
}

// post sends a JSON with a browser User-Agent and decodes the response into
// out, if there is one.
func post(t *testing.T, url, body string, headers map[string]string, out ...any) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", browserUA)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if len(out) > 0 && resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(out[0]); err != nil {
			t.Fatalf("POST %s: %v", url, err)
		}
	}
	return resp.StatusCode
}
