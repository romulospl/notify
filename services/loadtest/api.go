package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/romulospl/stellytics/services/collector/components/httpmetrics"
)

// route is a simulated route: the template (http.route) and how to build the real path.
type route struct {
	method   string
	template string
	path     func() string
	weight   int
}

func base32(n int) string { return randStr(n, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") }

var routes = []route{
	{"GET", "/accounts/{account_id}", func() string { return "/accounts/G" + base32(55) }, 30},
	{"GET", "/accounts/{account_id}/transactions", func() string { return "/accounts/G" + base32(55) + "/transactions" }, 12},
	{"GET", "/ledgers/{sequence}", func() string { return "/ledgers/" + strconv.Itoa(50_000_000+rand.IntN(1_000_000)) }, 15},
	{"GET", "/transactions/{hash}", func() string { return "/transactions/" + randStr(64, "0123456789abcdef") }, 12},
	{"POST", "/transactions", func() string { return "/transactions" }, 6},
	{"GET", "/assets", func() string { return "/assets" }, 6},
	{"GET", "/offers", func() string { return "/offers" }, 4},
	{"GET", "/orders/{uuid}", func() string {
		h := randStr(32, "0123456789abcdef")
		return "/orders/" + h[:8] + "-" + h[8:12] + "-4" + h[13:16] + "-8" + h[17:20] + "-" + h[20:]
	}, 5},
	{"GET", "/health", func() string { return "/health" }, 10},
}

var routeTotal = func() int {
	n := 0
	for _, r := range routes {
		n += r.weight
	}
	return n
}()

func pickRoute() route {
	x := rand.IntN(routeTotal)
	for _, r := range routes {
		if x < r.weight {
			return r
		}
		x -= r.weight
	}
	return routes[0]
}

func pickStatus() int {
	switch x := rand.IntN(1000); {
	case x < 950:
		return 200
	case x < 980:
		return 404
	case x < 995:
		return 400
	default:
		return 500
	}
}

// pickLatency: lognormal with a 40 ms median, between 1 ms and 30 s.
func pickLatency() float64 {
	return min(max(0.040*math.Exp(rand.NormFloat64()*1.0), 0.001), 30)
}

type histKey struct {
	route, method string
	status        int
}

type hist struct {
	counts [httpmetrics.NumBuckets]uint64
	sum    float64
}

type spanRec struct {
	route, path, method string
	status              int
	dur                 float64
	end                 time.Time
	useRoute            bool
}

// svc is a simulated service with the buffer of what has not been exported yet.
type svc struct {
	ServiceKey
	baseRows  int64
	baseline  int64        // request_count the service already had in api_metric_1m before the test
	simulated atomic.Int64 // simulated requests
	sentOK    atomic.Int64 // requests inside exports that got 2xx
	mu        sync.Mutex
	hists     map[histKey]*hist
	spans     []spanRec
}

func runAPI(args []string) error {
	fs := flag.NewFlagSet("api", flag.ExitOnError)
	stateFile := fs.String("state", "state.json", "state file from setup")
	collector := fs.String("collector", envOr("COLLECTOR_URL", "http://127.0.0.1:4318"), "the collector's OTLP/HTTP")
	stellyticsDB := fs.String("stellytics-db", envOr("STELLYTICS_DATABASE_URL", "postgresql://stellytics:stellytics@127.0.0.1:5432/stellytics"), "stellytics database, to check api_metric_1m")
	profile := fs.String("profile", "11.6x2m", "ratexduration steps of API requests per second")
	modes := fs.String("modes", "metrics,spans", "export modes to use (metrics, spans)")
	exportEvery := fs.Duration("export-interval", 10*time.Second, "metrics export interval (the OTel SDK default is 60 s)")
	spanBatch := fs.Int("span-batch", 512, "spans per batch (BatchSpanProcessor default)")
	spanFlush := fs.Duration("span-flush", time.Second, "maximum interval between span batches (the SDK default is 5 s)")
	settle := fs.Duration("settle", 15*time.Second, "wait before counting in api_metric_1m")
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
	if err := checkTargets(*allowRemote, map[string]string{"collector": *collector, "stellytics-db": *stellyticsDB}); err != nil {
		return err
	}
	var svcs []*svc
	for _, k := range st.Services {
		if strings.Contains(*modes, k.Mode) {
			svcs = append(svcs, &svc{ServiceKey: k, hists: map[histKey]*hist{}})
		}
	}
	if len(svcs) == 0 {
		return fmt.Errorf("no service of modes %q in the state", *modes)
	}
	w, err := newWatcher(*watchSpec, *dockerSpec)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.run(ctx, 2*time.Second)

	// Baseline: earlier runs with the same setup have already written rows.
	pre, err := pgx.Connect(ctx, *stellyticsDB)
	if err != nil {
		return err
	}
	for _, s := range svcs {
		if err := pre.QueryRow(ctx, `SELECT coalesce(sum(request_count), 0), count(*) FROM api_metric_1m WHERE api_service_id = $1`, s.ID).Scan(&s.baseline, &s.baseRows); err != nil {
			return err
		}
	}
	pre.Close(ctx)

	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: 100}}
	rec := newRecorder()
	var curStep atomic.Int64
	var exportFailures atomic.Int64

	post := func(s *svc, path string, body []byte, op string) bool {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, *collector+path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/x-protobuf")
		req.Header.Set("Authorization", "Bearer "+s.Key)
		t0 := time.Now()
		resp, err := client.Do(req)
		idx := int(curStep.Load())
		if err != nil {
			rec.add(idx, op, time.Since(t0), "err")
			exportFailures.Add(1)
			return false
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		rec.add(idx, op, time.Since(t0), strconv.Itoa(resp.StatusCode))
		if resp.StatusCode/100 != 2 {
			exportFailures.Add(1)
			return false
		}
		return true
	}

	flush := func(s *svc) {
		s.mu.Lock()
		hists, spans := s.hists, s.spans
		s.hists, s.spans = map[histKey]*hist{}, nil
		s.mu.Unlock()
		if len(hists) > 0 {
			var n uint64
			for _, h := range hists {
				for _, c := range h.counts {
					n += c
				}
			}
			if post(s, "/v1/metrics", marshalMetrics(hists, *exportEvery), "metrics") {
				s.sentOK.Add(int64(n))
			}
		}
		for len(spans) > 0 {
			n := min(len(spans), *spanBatch)
			if post(s, "/v1/traces", marshalSpans(spans[:n]), "traces") {
				s.sentOK.Add(int64(n))
			}
			spans = spans[n:]
		}
	}

	// Periodic exporters, one per service, as the SDK would do.
	var exporters sync.WaitGroup
	stop := make(chan struct{})
	for _, s := range svcs {
		every := *exportEvery
		if s.Mode == "spans" {
			every = *spanFlush
		}
		exporters.Add(1)
		go func() {
			defer exporters.Done()
			// Offset the start so that the services do not all export together.
			time.Sleep(time.Duration(rand.Int64N(int64(every))))
			t := time.NewTicker(every)
			defer t.Stop()
			for {
				select {
				case <-stop:
					return
				case <-t.C:
					flush(s)
				}
			}
		}()
	}

	fire := func(_ context.Context, _ int) {
		s := svcs[rand.IntN(len(svcs))]
		r, status, lat := pickRoute(), pickStatus(), pickLatency()
		s.simulated.Add(1)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.Mode == "metrics" {
			k := histKey{r.template, r.method, status}
			h := s.hists[k]
			if h == nil {
				h = &hist{}
				s.hists[k] = h
			}
			h.counts[httpmetrics.BucketIndex(lat)]++
			h.sum += lat
			return
		}
		s.spans = append(s.spans, spanRec{r.template, r.path(), r.method, status, lat, time.Now(), rand.IntN(2) == 0})
	}

	fmt.Printf("profile %s, %d services (%s), collector %s, metrics export every %s\n", *profile, len(svcs), *modes, *collector, *exportEvery)
	began := time.Now()
	fired, saturated, starts := drive(ctx, steps, 1000, func(i int, s step) {
		curStep.Store(int64(i))
		fmt.Printf("[%s] step %d: %s\n", time.Now().Format("15:04:05"), i, s)
	}, fire)
	elapsed := time.Since(began)
	close(stop)
	exporters.Wait()
	for _, s := range svcs {
		flush(s) // what was left in the buffer
	}
	rec.report(steps)
	w.report(steps, starts, time.Now())

	fmt.Printf("\nsimulated requests: %d in %s (%.2f/s); generator saturation: %d; failed exports: %d\n",
		fired, elapsed.Round(time.Second), float64(fired)/elapsed.Seconds(), saturated, exportFailures.Load())
	time.Sleep(*settle)
	return verifyAPI(ctx, *stellyticsDB, st, svcs)
}

func marshalMetrics(h map[histKey]*hist, interval time.Duration) []byte {
	now := time.Now()
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "loadtest-api")
	m := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	m.SetName("http.server.request.duration")
	m.SetUnit("s")
	hg := m.SetEmptyHistogram()
	hg.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	for k, v := range h {
		dp := hg.DataPoints().AppendEmpty()
		dp.SetStartTimestamp(pcommon.NewTimestampFromTime(now.Add(-interval)))
		dp.SetTimestamp(pcommon.NewTimestampFromTime(now))
		var n uint64
		for _, c := range v.counts {
			n += c
		}
		dp.SetCount(n)
		dp.SetSum(v.sum)
		dp.ExplicitBounds().FromRaw(httpmetrics.Bounds[:])
		dp.BucketCounts().FromRaw(v.counts[:])
		dp.Attributes().PutStr("http.route", k.route)
		dp.Attributes().PutStr("http.request.method", k.method)
		dp.Attributes().PutInt("http.response.status_code", int64(k.status))
	}
	b, _ := (&pmetric.ProtoMarshaler{}).MarshalMetrics(md)
	return b
}

func marshalSpans(spans []spanRec) []byte {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "loadtest-api")
	out := rs.ScopeSpans().AppendEmpty().Spans()
	for _, s := range spans {
		sp := out.AppendEmpty()
		sp.SetName(s.method + " " + s.route)
		sp.SetKind(ptrace.SpanKindServer)
		sp.SetStartTimestamp(pcommon.NewTimestampFromTime(s.end.Add(-time.Duration(s.dur * float64(time.Second)))))
		sp.SetEndTimestamp(pcommon.NewTimestampFromTime(s.end))
		a := sp.Attributes()
		a.PutStr("http.request.method", s.method)
		a.PutInt("http.response.status_code", int64(s.status))
		a.PutStr("url.path", s.path)
		if s.useRoute {
			a.PutStr("http.route", s.route)
		}
	}
	b, _ := (&ptrace.ProtoMarshaler{}).MarshalTraces(td)
	return b
}

// verifyAPI checks in api_metric_1m what was sent successfully.
func verifyAPI(ctx context.Context, dsn string, st State, svcs []*svc) error {
	db, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer db.Close(ctx)
	fmt.Printf("\n%-14s %-8s %10s %10s %10s %8s %7s\n", "service", "mode", "simulated", "sent*", "written", "rows", "routes")
	var sim, sent, got int64
	for _, s := range svcs {
		var n, rows, routes int64
		if err := db.QueryRow(ctx, `SELECT coalesce(sum(request_count), 0), count(*), count(DISTINCT route)
			FROM api_metric_1m WHERE tenant_id = $1 AND api_service_id = $2`, st.APITenantID, s.ID).Scan(&n, &rows, &routes); err != nil {
			return err
		}
		n -= s.baseline
		rows -= s.baseRows
		fmt.Printf("%-14s %-8s %10d %10d %10d %8d %7d\n", s.ID[:8], s.Mode, s.simulated.Load(), s.sentOK.Load(), n, rows, routes)
		sim += s.simulated.Load()
		sent += s.sentOK.Load()
		got += n
	}
	fmt.Printf("%-14s %-8s %10d %10d %10d\n", "total", "", sim, sent, got)
	fmt.Println("* sent = requests inside OTLP exports that got 2xx")
	var bad, total int64
	if err := db.QueryRow(ctx, `SELECT count(*) FILTER (WHERE (SELECT sum(b) FROM unnest(duration_buckets) b) <> request_count OR duration_sum <= 0), count(*)
		FROM api_metric_1m WHERE tenant_id = $1`, st.APITenantID).Scan(&bad, &total); err != nil {
		return err
	}
	fmt.Printf("rows with buckets that do not add up to the count or duration sum <= 0: %d of %d\n", bad, total)
	var other int64
	_ = db.QueryRow(ctx, `SELECT coalesce(sum(request_count), 0) FROM api_metric_1m WHERE tenant_id = $1 AND route = '{other}'`, st.APITenantID).Scan(&other)
	fmt.Printf("requests on the {other} route (route cap): %d\n", other)
	if got != sent {
		fmt.Printf("DIFFERENCE: written %d, sent %d (%+d)\n", got, sent, got-sent)
	}
	return nil
}
