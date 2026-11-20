//go:build e2e

package e2e

// #24: the full IP is never persisted, and Umami's geolocation uses the
// truncated IP. The test sends the visitor's IP in X-Forwarded-For, as Caddy
// would; for that the gateway needs to trust the test's connection
// (INGEST_TRUSTED_PROXIES in Compose).

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Public Google addresses, which Umami's GeoLite2 database places in the US,
// even after being truncated (8.8.8.0 and 2001:4860:4860::).
var visitors = []struct{ ip, truncated string }{
	{"8.8.8.77", "8.8.8.0"},
	{"2001:4860:4860::8888", "2001:4860:4860::"},
}

func TestFullIPNeverPersisted(t *testing.T) {
	ctx := context.Background()
	token := umamiLogin(t)
	websiteID := umamiCreateWebsite(t, token)
	t.Cleanup(func() { umamiDo(t, token, http.MethodDelete, "/api/websites/"+websiteID, nil, nil) })

	stellytics := connect(t, stellyticsDB)
	umami := connect(t, umamiDB)
	registerSite(t, stellytics, websiteID)

	for _, v := range visitors {
		if code := sendEvent(t, websiteID, "/privacy", "X-Forwarded-For", v.ip); code != http.StatusNoContent {
			t.Fatalf("event from %s: status = %d, want 204", v.ip, code)
		}
	}

	// One visitor per IP becomes one session in Umami, geolocated by the
	// truncated IP.
	deadline := time.Now().Add(60 * time.Second)
	var countries []string
	for {
		countries = countries[:0]
		rows, err := umami.Query(ctx, `SELECT coalesce(country, '') FROM session WHERE website_id = $1`, websiteID)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var c string
			if err := rows.Scan(&c); err != nil {
				t.Fatal(err)
			}
			countries = append(countries, strings.TrimSpace(c))
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		if len(countries) >= len(visitors) || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Second)
	}
	if len(countries) != len(visitors) {
		t.Fatalf("sessions in Umami = %d, want %d (does the gateway trust the test's X-Forwarded-For?)", len(countries), len(visitors))
	}
	for _, c := range countries {
		if c != "US" {
			t.Errorf("session country = %q, want US (geolocation by the truncated IP)", c)
		}
	}

	// No column of any table, in either database, stores the full IP.
	for name, db := range map[string]*pgx.Conn{"umami": umami, "stellytics": stellytics} {
		for _, v := range visitors {
			for _, hit := range findText(t, db, v.ip) {
				t.Errorf("full IP %s written to database %s, in %s", v.ip, name, hit)
			}
		}
	}
}

func connect(t *testing.T, url string) *pgx.Conn {
	t.Helper()
	db, err := pgx.Connect(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close(context.Background()) })
	return db
}

// findText looks for needle in every text, JSON or address column of the user's
// tables and returns "table.column" for each hit.
func findText(t *testing.T, db *pgx.Conn, needle string) []string {
	t.Helper()
	ctx := context.Background()
	rows, err := db.Query(ctx, `
		SELECT c.table_schema, c.table_name, c.column_name
		FROM information_schema.columns c
		JOIN information_schema.tables t USING (table_schema, table_name)
		WHERE t.table_type = 'BASE TABLE'
		  AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
		  AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'inet', 'cidr', 'ARRAY')`)
	if err != nil {
		t.Fatal(err)
	}
	cols, err := pgx.CollectRows(rows, pgx.RowToStructByPos[struct{ Schema, Table, Column string }])
	if err != nil {
		t.Fatal(err)
	}
	if len(cols) == 0 {
		t.Fatal("no text column found; can the user see the tables?")
	}

	var hits []string
	for _, c := range cols {
		table := pgx.Identifier{c.Schema, c.Table}.Sanitize()
		col := pgx.Identifier{c.Column}.Sanitize()
		var n int
		q := fmt.Sprintf(`SELECT count(*) FROM %s WHERE strpos(%s::text, $1) > 0`, table, col)
		if err := db.QueryRow(ctx, q, needle).Scan(&n); err != nil {
			t.Fatalf("%s.%s: %v", c.Table, c.Column, err)
		}
		if n > 0 {
			hits = append(hits, c.Table+"."+c.Column)
		}
	}
	return hits
}
