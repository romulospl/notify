package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/bits"
	"math/rand/v2"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
)

var userAgents = []string{
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
	"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
}

var (
	languages = []string{"en-US", "it-IT", "es-ES", "de-DE", "fr-FR", "ja-JP"}
	screens   = []string{"1920x1080", "1366x768", "390x844", "1440x900", "412x915", "2560x1440"}
	pages     = []string{"/", "/docs", "/docs/getting-started", "/pricing", "/blog", "/blog/stellar-soroban", "/about", "/app/swap", "/app/pools", "/app/portfolio"}
)

// visitor is a simulated browser: fixed IP, UA, language and screen. Each
// visitor has its own /24 (the gateway truncates the IPv4 to that block), so
// that the per-truncated-IP limit and the fingerprint limit behave as with
// real visitors.
type visitor struct {
	ip, ua, lang, screen string
}

func newVisitor(i int) visitor {
	return visitor{
		ip:     fmt.Sprintf("10.%d.%d.%d", i/256%256, i%256, 1+i%250),
		ua:     userAgents[i%len(userAgents)],
		lang:   languages[i/7%len(languages)],
		screen: screens[i/5%len(screens)],
	}
}

// solve finds the nonce of the JS proof (same algorithm as internal/proof,
// which Go does not allow importing from outside services/ingest-web:
// SHA-256(token+":"+nonce) with n leading zero bits). If it diverges from the
// gateway, the whole test becomes dropped 204s and the check in Umami shows
// zero events.
func solve(token string, n int) string {
	for i := uint64(0); ; i++ {
		nonce := strconv.FormatUint(i, 10)
		sum := sha256.Sum256([]byte(token + ":" + nonce))
		z := 0
		for _, c := range sum {
			if c != 0 {
				z += bits.LeadingZeros8(c)
				break
			}
			z += 8
		}
		if z >= n {
			return nonce
		}
	}
}

func runWeb(args []string) error {
	fs := flag.NewFlagSet("web", flag.ExitOnError)
	stateFile := fs.String("state", "state.json", "state file from setup")
	gateway := fs.String("gateway", envOr("GATEWAY_URL", "http://127.0.0.1:3002"), "gateway URL")
	umamiDB := fs.String("umami-db", envOr("UMAMI_DATABASE_URL", "postgresql://umami:umami@127.0.0.1:5432/umami"), "Umami database, to check what arrived")
	profile := fs.String("profile", "11.6x2m", "ratexduration steps of page views per second")
	visitors := fs.Int("visitors", 20000, "distinct visitors (/24 IPs and fingerprints)")
	maxInflight := fs.Int("max-inflight", 2000, "maximum page views in flight")
	settle := fs.Duration("settle", 10*time.Second, "wait before counting in Umami")
	allowRemote := fs.Bool("allow-remote", false, "allows targets that are not loopback")
	watchSpec := fs.String("watch", "", "local processes name=pid,...")
	dockerSpec := fs.String("docker", "", "containers for docker stats, comma-separated")
	_ = fs.Parse(args)

	steps, err := parseProfile(*profile)
	if err != nil {
		return err
	}
	st, err := loadState(*stateFile)
	if err != nil {
		return err
	}
	if err := checkTargets(*allowRemote, map[string]string{"gateway": *gateway, "umami-db": *umamiDB}); err != nil {
		return err
	}
	w, err := newWatcher(*watchSpec, *dockerSpec)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.run(ctx, 2*time.Second)

	client := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns: 1000, MaxIdleConnsPerHost: 1000, MaxConnsPerHost: 0,
			IdleConnTimeout: 90 * time.Second,
		},
	}
	rec := newRecorder()
	var accepted, notAccepted, failed atomic.Int64
	umamiBefore, err := countUmami(ctx, *umamiDB, st.UmamiWebsiteID)
	if err != nil {
		return err
	}

	fire := func(ctx context.Context, stepIdx int) {
		v := newVisitor(rand.IntN(*visitors))
		page := pages[rand.IntN(len(pages))]
		do := func(op string, req *http.Request) (*http.Response, error) {
			req.Header.Set("X-Forwarded-For", v.ip)
			req.Header.Set("User-Agent", v.ua)
			req.Header.Set("Accept-Language", v.lang)
			t0 := time.Now()
			resp, err := client.Do(req)
			if err != nil {
				rec.add(stepIdx, op, time.Since(t0), "err")
				return nil, err
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			d := time.Since(t0)
			rec.add(stepIdx, op, d, strconv.Itoa(resp.StatusCode))
			// Separate row per status: with the relay limit on, the responses of
			// each status are measured separately; 204 includes drops.
			rec.add(stepIdx, op+" "+strconv.Itoa(resp.StatusCode), d, strconv.Itoa(resp.StatusCode))
			return resp, nil
		}

		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, *gateway+"/c?s="+st.UmamiWebsiteID, nil)
		t0 := time.Now()
		resp, err := client.Do(withHeaders(req, v))
		if err != nil {
			rec.add(stepIdx, "challenge", time.Since(t0), "err")
			failed.Add(1)
			return
		}
		var ch struct {
			Token string `json:"t"`
			Bits  int    `json:"d"`
		}
		decErr := json.NewDecoder(resp.Body).Decode(&ch)
		resp.Body.Close()
		rec.add(stepIdx, "challenge", time.Since(t0), strconv.Itoa(resp.StatusCode))
		if resp.StatusCode != 200 || decErr != nil {
			failed.Add(1)
			return
		}

		ts := time.Now()
		nonce := solve(ch.Token, ch.Bits)
		rec.add(stepIdx, "pow(client)", time.Since(ts), "200")

		body, _ := json.Marshal(map[string]any{
			"type": "event",
			"p":    map[string]string{"t": ch.Token, "n": nonce},
			"payload": map[string]string{
				"website": st.UmamiWebsiteID, "hostname": "loadtest.example", "url": page,
				"title": "loadtest " + page, "language": v.lang, "screen": v.screen,
			},
		})
		post, _ := http.NewRequestWithContext(ctx, http.MethodPost, *gateway+"/e", bytes.NewReader(body))
		post.Header.Set("Content-Type", "text/plain;charset=UTF-8")
		r2, err := do("event", post)
		switch {
		case err != nil:
			failed.Add(1)
		case r2.StatusCode == http.StatusNoContent:
			accepted.Add(1) // 204: accepted or dropped; Umami tells which
		default:
			notAccepted.Add(1)
		}
	}

	fmt.Printf("profile %s, %d visitors, gateway %s\n", *profile, *visitors, *gateway)
	var fired, saturated int64
	var starts []time.Time
	began := time.Now()
	fired, saturated, starts = drive(ctx, steps, *maxInflight, func(i int, s step) {
		fmt.Printf("[%s] step %d: %s\n", time.Now().Format("15:04:05"), i, s)
	}, fire)
	elapsed := time.Since(began)
	rec.report(steps)
	w.report(steps, starts, time.Now())

	fmt.Printf("\npage views started: %d in %s (%.2f/s); generator saturation: %d\n", fired, elapsed.Round(time.Second), float64(fired)/elapsed.Seconds(), saturated)
	fmt.Printf("POST /e with 204: %d; other status (429 etc.): %d; network or challenge failure: %d\n", accepted.Load(), notAccepted.Load(), failed.Load())
	time.Sleep(*settle)
	after, err := countUmami(ctx, *umamiDB, st.UmamiWebsiteID)
	if err != nil {
		return err
	}
	got := after - umamiBefore
	fmt.Printf("page views written to Umami: %d of %d with 204 (%.3f%%); dropped or lost: %d\n",
		got, accepted.Load(), 100*float64(got)/float64(max(accepted.Load(), 1)), accepted.Load()-got)
	return nil
}

func withHeaders(req *http.Request, v visitor) *http.Request {
	req.Header.Set("X-Forwarded-For", v.ip)
	req.Header.Set("User-Agent", v.ua)
	req.Header.Set("Accept-Language", v.lang)
	return req
}

func countUmami(ctx context.Context, dsn, website string) (int64, error) {
	c, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return 0, err
	}
	defer c.Close(ctx)
	var n int64
	err = c.QueryRow(ctx, `SELECT count(*) FROM website_event WHERE website_id = $1`, website).Scan(&n)
	return n, err
}
