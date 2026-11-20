package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// State is what setup creates, written as JSON for the other subcommands.
type State struct {
	UmamiURL string `json:"umami_url"`
	// Web
	UmamiWebsiteID string `json:"umami_website_id"`
	WebTenantID    string `json:"web_tenant_id"`
	// API
	APITenantID string       `json:"api_tenant_id"`
	Services    []ServiceKey `json:"services"`
	UserID      string       `json:"user_id"`
}

// ServiceKey is an API service of the test with its ingest key.
type ServiceKey struct {
	ID   string `json:"id"`
	Mode string `json:"mode"` // "metrics" or "spans"
	Key  string `json:"key"`
}

func runSetup(args []string) error {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	stellyticsDB := fs.String("stellytics-db", envOr("STELLYTICS_DATABASE_URL", "postgresql://stellytics:stellytics@127.0.0.1:5432/stellytics"), "stellytics database (owner of the tables)")
	umamiURL := fs.String("umami-url", envOr("UMAMI_URL", "http://127.0.0.1:3001"), "Umami published on the host")
	out := fs.String("out", "state.json", "state file (holds the full ntf_ keys, mode 0600)")
	metricsSvcs := fs.Int("metrics-services", 4, "API services that send metrics")
	spansSvcs := fs.Int("spans-services", 2, "API services that send only spans")
	allowRemote := fs.Bool("allow-remote", false, "allows targets that are not loopback")
	_ = fs.Parse(args)

	if err := checkTargets(*allowRemote, map[string]string{"stellytics-db": *stellyticsDB, "umami-url": *umamiURL}); err != nil {
		return err
	}
	ctx := context.Background()
	db, err := pgx.Connect(ctx, *stellyticsDB)
	if err != nil {
		return err
	}
	defer db.Close(ctx)

	st := State{UmamiURL: *umamiURL, UserID: "loadtest-" + randStr(8, "abcdefghijklmnopqrstuvwxyz0123456789")}
	// The state is written before each step and after it: if something fails
	// halfway, teardown finds what was already created.
	save := func() error { return saveState(*out, st) }
	if err := save(); err != nil {
		return err
	}
	err = func() error {
		if _, err := db.Exec(ctx, `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'loadtest', $2, true)`,
			st.UserID, st.UserID+"@example.invalid"); err != nil {
			return err
		}
		// Web: site in Umami and tenant with that site in the stellytics database.
		tok, err := umamiLogin(*umamiURL)
		if err != nil {
			return err
		}
		var site struct {
			ID string `json:"id"`
		}
		if err := umamiDo(*umamiURL, tok, http.MethodPost, "/api/websites",
			map[string]string{"name": st.UserID, "domain": "loadtest.example"}, &site); err != nil || site.ID == "" {
			return fmt.Errorf("creating site in Umami: %v", err)
		}
		st.UmamiWebsiteID = site.ID
		if err := save(); err != nil {
			return err
		}
		if err := db.QueryRow(ctx, `INSERT INTO tenant (name, slug, status) VALUES ($1, $1, 'active') RETURNING id`, st.UserID+"-web").Scan(&st.WebTenantID); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `INSERT INTO site (tenant_id, name, domain, umami_website_id) VALUES ($1, 'loadtest', 'loadtest.example', $2)`,
			st.WebTenantID, st.UmamiWebsiteID); err != nil {
			return err
		}
		if err := save(); err != nil {
			return err
		}

		// API: one tenant with several services, each with its own key.
		if err := db.QueryRow(ctx, `INSERT INTO tenant (name, slug, status) VALUES ($1, $1, 'active') RETURNING id`, st.UserID+"-api").Scan(&st.APITenantID); err != nil {
			return err
		}
		if err := save(); err != nil {
			return err
		}
		mk := func(mode string, i int) error {
			var svc string
			if err := db.QueryRow(ctx, `INSERT INTO api_service (tenant_id, name) VALUES ($1, $2) RETURNING id`,
				st.APITenantID, fmt.Sprintf("%s-%d", mode, i)).Scan(&svc); err != nil {
				return err
			}
			prefix := randStr(8, "abcdefghijklmnopqrstuvwxyz234567")
			secret := randStr(43, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
			key := "ntf_" + prefix + "_" + secret
			if _, err := db.Exec(ctx, `INSERT INTO ingest_key (api_service_id, tenant_id, prefix, key_hash, created_by)
				VALUES ($1, $2, $3, sha256(convert_to($4, 'UTF8')), $5)`, svc, st.APITenantID, prefix, key, st.UserID); err != nil {
				return err
			}
			st.Services = append(st.Services, ServiceKey{ID: svc, Mode: mode, Key: key})
			return save()
		}
		for i := 0; i < *metricsSvcs; i++ {
			if err := mk("metrics", i); err != nil {
				return err
			}
		}
		for i := 0; i < *spansSvcs; i++ {
			if err := mk("spans", i); err != nil {
				return err
			}
		}
		return nil
	}()
	if err != nil {
		return fmt.Errorf("setup stopped halfway (%w); what was already created is in %s: run `loadtest teardown -state %s`", err, *out, *out)
	}
	fmt.Printf("setup ok: site %s, API tenant %s, %d services; state in %s\n", st.UmamiWebsiteID, st.APITenantID, len(st.Services), *out)
	return nil
}

func saveState(path string, st State) error {
	b, _ := json.MarshalIndent(st, "", "  ")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// validateState checks that the state describes only loadtest data.
func validateState(st State) error {
	if !strings.HasPrefix(st.UserID, "loadtest-") || len(st.UserID) <= len("loadtest-") || strings.ContainsAny(st.UserID, "%_ ") {
		return fmt.Errorf("user_id %q does not start with loadtest-: the file is not from a setup", st.UserID)
	}
	return nil
}

func runTeardown(args []string) error {
	fs := flag.NewFlagSet("teardown", flag.ExitOnError)
	stellyticsDB := fs.String("stellytics-db", envOr("STELLYTICS_DATABASE_URL", "postgresql://stellytics:stellytics@127.0.0.1:5432/stellytics"), "stellytics database")
	in := fs.String("state", "state.json", "state file")
	allowRemote := fs.Bool("allow-remote", false, "allows targets that are not loopback")
	_ = fs.Parse(args)
	st, err := loadState(*in)
	if err != nil {
		return err
	}
	if err := validateState(st); err != nil {
		return err
	}
	if err := checkTargets(*allowRemote, map[string]string{"stellytics-db": *stellyticsDB, "umami-url": st.UmamiURL}); err != nil {
		return err
	}
	ctx := context.Background()
	db, err := pgx.Connect(ctx, *stellyticsDB)
	if err != nil {
		return err
	}
	defer db.Close(ctx)

	// The tenants are found by the slug setup gave them; the IDs in the file,
	// if any, must match. Nothing is deleted if something does not match.
	var u int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM "user" WHERE id = $1 AND id LIKE 'loadtest-%'`, st.UserID).Scan(&u); err != nil {
		return err
	}
	if u == 0 {
		fmt.Printf("warning: user %s does not exist in the database; only the tenants and the site will be looked up\n", st.UserID)
	}
	ids := map[string]string{}
	for suffix, recorded := range map[string]string{"-web": st.WebTenantID, "-api": st.APITenantID} {
		var id string
		err := db.QueryRow(ctx, `SELECT id FROM tenant WHERE slug = $1`, st.UserID+suffix).Scan(&id)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			continue
		case err != nil:
			return err
		case recorded != "" && recorded != id:
			return fmt.Errorf("tenant %s%s has id %s in the database and %s in the state: aborting, nothing was deleted", st.UserID, suffix, id, recorded)
		}
		ids[suffix] = id
	}

	if st.UmamiWebsiteID != "" {
		tok, err := umamiLogin(st.UmamiURL)
		if err == nil {
			err = umamiDo(st.UmamiURL, tok, http.MethodDelete, "/api/websites/"+st.UmamiWebsiteID, nil, nil)
		}
		if err != nil {
			fmt.Printf("WARNING: could not delete site %s in Umami (%v); delete it by hand\n", st.UmamiWebsiteID, err)
		}
	}

	// One transaction: it deletes either everything in the stellytics database or nothing.
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	for _, id := range ids {
		for _, q := range []string{
			`DELETE FROM api_metric_1m WHERE tenant_id = $1`,
			`DELETE FROM api_metric_1h WHERE tenant_id = $1`,
			`DELETE FROM api_metric_1d WHERE tenant_id = $1`,
			`DELETE FROM ingest_key WHERE tenant_id = $1`,
			`DELETE FROM api_service WHERE tenant_id = $1`,
			`DELETE FROM site WHERE tenant_id = $1`,
			`DELETE FROM tenant WHERE id = $1`,
		} {
			if _, err := tx.Exec(ctx, q, id); err != nil {
				return fmt.Errorf("%s: %w (transaction rolled back: nothing was deleted in the stellytics database; the Umami site may already have been deleted)", q, err)
			}
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM "user" WHERE id = $1 AND id LIKE 'loadtest-%'`, st.UserID); err != nil {
		return fmt.Errorf("deleting user: %w (transaction rolled back: nothing was deleted in the stellytics database)", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	fmt.Printf("teardown ok: %d tenants and user %s deleted\n", len(ids), st.UserID)
	return nil
}

func loadState(path string) (State, error) {
	var st State
	b, err := os.ReadFile(path)
	if err != nil {
		return st, err
	}
	return st, json.Unmarshal(b, &st)
}

func umamiLogin(base string) (string, error) {
	var out struct {
		Token string `json:"token"`
	}
	err := umamiDo(base, "", http.MethodPost, "/api/auth/login",
		map[string]string{"username": envOr("UMAMI_USER", "admin"), "password": envOr("UMAMI_PASSWORD", "umami")}, &out)
	if err == nil && out.Token == "" {
		err = fmt.Errorf("login without token")
	}
	return out.Token, err
}

func umamiDo(base, token, method, path string, body, out any) error {
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, base+path, rd)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	c := &http.Client{Timeout: 30 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("%s %s: status %d", method, path, resp.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func randStr(n int, alphabet string) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}
