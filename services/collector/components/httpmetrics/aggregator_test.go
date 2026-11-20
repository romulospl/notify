package httpmetrics

import (
	"fmt"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/romulospl/stellytics/services/collector/components/tenantattr"
)

const (
	tenantID  = "6f1c2b9e-3a4d-4c8e-9f00-1234567890ab"
	serviceID = "0a0b0c0d-0e0f-4000-8000-000000000001"
	account   = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
)

var base = time.Date(2026, 11, 14, 10, 0, 30, 0, time.UTC)

func stamp(res pcommon.Resource) {
	res.Attributes().PutStr(tenantattr.AttrTenantID, tenantID)
	res.Attributes().PutStr(tenantattr.AttrServiceID, serviceID)
	res.Attributes().PutStr("service.name", "api")
}

func ts(t time.Time) pcommon.Timestamp { return pcommon.NewTimestampFromTime(t) }

type spanOpt func(ptrace.Span)

func addSpan(td ptrace.Traces, kind ptrace.SpanKind, dur time.Duration, opts ...spanOpt) {
	var rs ptrace.ResourceSpans
	if td.ResourceSpans().Len() == 0 {
		rs = td.ResourceSpans().AppendEmpty()
		stamp(rs.Resource())
		rs.ScopeSpans().AppendEmpty()
	} else {
		rs = td.ResourceSpans().At(0)
	}
	sp := rs.ScopeSpans().At(0).Spans().AppendEmpty()
	sp.SetKind(kind)
	sp.SetStartTimestamp(ts(base))
	sp.SetEndTimestamp(ts(base.Add(dur)))
	sp.Attributes().PutStr("http.request.method", "GET")
	for _, o := range opts {
		o(sp)
	}
}

func attr(k string, v any) spanOpt {
	return func(sp ptrace.Span) {
		switch x := v.(type) {
		case string:
			sp.Attributes().PutStr(k, x)
		case int:
			sp.Attributes().PutInt(k, int64(x))
		}
	}
}

func key(route, method string, status int16) Key {
	return Key{Bucket: base.Truncate(time.Minute), TenantID: tenantID, ServiceID: serviceID, Route: route, Method: method, Status: status}
}

func TestTracesExtractsServerHTTPSpans(t *testing.T) {
	td := ptrace.NewTraces()
	// Two requests on the same normalized route, one slow.
	addSpan(td, ptrace.SpanKindServer, 20*time.Millisecond,
		attr("url.path", "/accounts/"+account+"/payments/"), attr("http.response.status_code", 200),
		attr("user.id", "alice"), attr("url.query", "token=secret"))
	addSpan(td, ptrace.SpanKindServer, 3*time.Second,
		attr("url.path", "/accounts/GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5/payments"), attr("http.response.status_code", 200))
	// The client's http.route wins; old attribute convention.
	addSpan(td, ptrace.SpanKindServer, 5*time.Millisecond,
		func(sp ptrace.Span) { sp.Attributes().Remove("http.request.method") },
		attr("http.method", "POST"), attr("http.route", "/users/:id"), attr("http.status_code", "201"))
	// Odd method, without route or status.
	addSpan(td, ptrace.SpanKindServer, time.Millisecond, attr("http.request.method", "PURGE"))
	// Ignored: client, internal and server without an HTTP attribute.
	addSpan(td, ptrace.SpanKindClient, time.Millisecond, attr("url.path", "/x"))
	addSpan(td, ptrace.SpanKindInternal, time.Millisecond)
	addSpan(td, ptrace.SpanKindServer, time.Millisecond, func(sp ptrace.Span) { sp.Attributes().Clear() })

	got := New().WithClock(func() time.Time { return base }).Traces(td)

	want := map[Key]Point{
		key("/accounts/{address}/payments", "GET", 200): {Count: 2, Sum: 3.02, Buckets: buckets(map[int]int64{2: 1, 11: 1})},
		key("/users/:id", "POST", 201):                  {Count: 1, Sum: 0.005, Buckets: buckets(map[int]int64{0: 1})},
		key(RouteUnknown, MethodOther, 0):               {Count: 1, Sum: 0.001, Buckets: buckets(map[int]int64{0: 1})},
	}
	assertBatch(t, got, want)
}

func TestTracesIgnoreUnauthenticatedResource(t *testing.T) {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	sp := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	sp.SetKind(ptrace.SpanKindServer)
	sp.Attributes().PutStr("http.request.method", "GET")
	if b := New().Traces(td); len(b) != 0 {
		t.Fatalf("resource without tenant produced %d rows", len(b))
	}
}

// histogram builds a point of http.server.request.duration.
func histogram(md pmetric.Metrics, name, unit string, temp pmetric.AggregationTemporality, start, at time.Time,
	bounds []float64, counts []uint64, sum float64, route string) {
	var rm pmetric.ResourceMetrics
	if md.ResourceMetrics().Len() == 0 {
		rm = md.ResourceMetrics().AppendEmpty()
		stamp(rm.Resource())
		rm.ScopeMetrics().AppendEmpty()
	} else {
		rm = md.ResourceMetrics().At(0)
	}
	m := rm.ScopeMetrics().At(0).Metrics().AppendEmpty()
	m.SetName(name)
	m.SetUnit(unit)
	h := m.SetEmptyHistogram()
	h.SetAggregationTemporality(temp)
	dp := h.DataPoints().AppendEmpty()
	dp.SetStartTimestamp(ts(start))
	dp.SetTimestamp(ts(at))
	var total uint64
	for _, c := range counts {
		total += c
	}
	dp.SetCount(total)
	dp.SetSum(sum)
	dp.ExplicitBounds().FromRaw(bounds)
	dp.BucketCounts().FromRaw(counts)
	dp.Attributes().PutStr("http.route", route)
	dp.Attributes().PutStr("http.request.method", "GET")
	dp.Attributes().PutInt("http.response.status_code", 200)
}

func TestMetricsDeltaSameBounds(t *testing.T) {
	md := pmetric.NewMetrics()
	counts := make([]uint64, NumBuckets)
	counts[2], counts[14] = 3, 1
	histogram(md, "http.server.request.duration", "s", pmetric.AggregationTemporalityDelta,
		base.Add(-time.Minute), base, Bounds[:], counts, 12.06, "/ledgers/{id}")
	got := New().WithClock(func() time.Time { return base }).Metrics(md)
	assertBatch(t, got, map[Key]Point{
		key("/ledgers/{id}", "GET", 200): {Count: 4, Sum: 12.06, Buckets: buckets(map[int]int64{2: 3, 14: 1})},
	})
}

func TestMetricsRemapsOtherBoundsAndMilliseconds(t *testing.T) {
	md := pmetric.NewMetrics()
	// Old one, in ms, with its own bounds: (..5], (5..30], (30..2000], (2000..].
	histogram(md, "http.server.duration", "ms", pmetric.AggregationTemporalityDelta,
		base.Add(-time.Minute), base, []float64{5, 30, 2000}, []uint64{1, 2, 3, 4}, 30000, "/x")
	got := New().WithClock(func() time.Time { return base }).Metrics(md)
	// 5 ms -> bucket 0 (0.005); 30 ms -> bucket 3 (0.05); 2 s -> bucket 10 (2.5); +Inf -> 14.
	assertBatch(t, got, map[Key]Point{
		key("/x", "GET", 200): {Count: 10, Sum: 30, Buckets: buckets(map[int]int64{0: 1, 3: 2, 10: 3, 14: 4})},
	})
}

func TestMetricsCumulative(t *testing.T) {
	now := base
	a := New().WithClock(func() time.Time { return now })
	b := Bounds[:]
	send := func(start, at time.Time, n uint64) Batch {
		md := pmetric.NewMetrics()
		counts := make([]uint64, NumBuckets)
		counts[1] = n
		histogram(md, "http.server.request.duration", "s", pmetric.AggregationTemporalityCumulative, start, at, b, counts, float64(n)*0.01, "/c")
		return a.Metrics(md)
	}
	count := func(bt Batch) int64 {
		var c int64
		for _, p := range bt {
			c += p.Count
		}
		return c
	}

	// Old process (started 1 h ago): the first point only becomes the baseline.
	old := base.Add(-time.Hour)
	if c := count(send(old, base, 100)); c != 0 {
		t.Errorf("first point of an old process counted %d, want 0", c)
	}
	if c := count(send(old, base.Add(time.Minute), 130)); c != 30 {
		t.Errorf("delta = %d, want 30", c)
	}
	// Process restart: new StartTimestamp, counts in full.
	restart := base.Add(2 * time.Minute)
	if c := count(send(restart, restart.Add(time.Minute), 7)); c != 7 {
		t.Errorf("after the restart = %d, want 7", c)
	}
	// A value that drops without a new StartTimestamp is also a restart.
	if c := count(send(restart, restart.Add(2*time.Minute), 2)); c != 2 {
		t.Errorf("drop = %d, want 2", c)
	}

	// A new series from a freshly started process counts in full.
	a2 := New().WithClock(func() time.Time { return now })
	md := pmetric.NewMetrics()
	counts := make([]uint64, NumBuckets)
	counts[0] = 5
	histogram(md, "http.server.request.duration", "s", pmetric.AggregationTemporalityCumulative,
		base.Add(-time.Minute), base, b, counts, 0.01, "/new")
	if c := count(a2.Metrics(md)); c != 5 {
		t.Errorf("new process = %d, want 5", c)
	}
}

func TestMetricPrecedenceOverSpans(t *testing.T) {
	now := base
	a := New().WithClock(func() time.Time { return now })
	spans := func() int {
		td := ptrace.NewTraces()
		addSpan(td, ptrace.SpanKindServer, 10*time.Millisecond, attr("url.path", "/p"))
		return len(a.Traces(td))
	}
	if spans() != 1 {
		t.Fatal("without a metric, the span should count")
	}
	md := pmetric.NewMetrics()
	histogram(md, "http.server.request.duration", "s", pmetric.AggregationTemporalityDelta,
		base.Add(-time.Minute), base, Bounds[:], make([]uint64, NumBuckets), 0, "/p")
	a.Metrics(md)
	if spans() != 0 {
		t.Error("with the recent metric, the span should not count (D9)")
	}
	now = base.Add(16 * time.Minute)
	if spans() != 1 {
		t.Error("15 minutes without a metric, the span counts again")
	}
}

func TestIgnoresOtherMetrics(t *testing.T) {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	stamp(rm.Resource())
	m := rm.ScopeMetrics().AppendEmpty().Metrics().AppendEmpty()
	m.SetName("process.cpu.time")
	m.SetEmptySum().DataPoints().AppendEmpty().SetIntValue(5)
	g := rm.ScopeMetrics().At(0).Metrics().AppendEmpty()
	g.SetName("http.server.request.duration")
	g.SetEmptyGauge().DataPoints().AppendEmpty().SetDoubleValue(1)
	if b := New().Metrics(md); len(b) != 0 {
		t.Fatalf("metrics outside the contract produced %d rows", len(b))
	}
}

func TestRouteCap(t *testing.T) {
	a := New().WithClock(func() time.Time { return base })
	td := ptrace.NewTraces()
	for i := range MaxRoutesPerDay + 20 {
		addSpan(td, ptrace.SpanKindServer, time.Millisecond, attr("http.route", fmt.Sprintf("/r%d", i)))
	}
	got := a.Traces(td)
	if len(got) != MaxRoutesPerDay+1 {
		t.Fatalf("rows = %d, want %d routes plus {other}", len(got), MaxRoutesPerDay+1)
	}
	if p := got[key(RouteOther, "GET", 0)]; p == nil || p.Count != 20 {
		t.Fatalf("{other} = %+v, want 20 requests", p)
	}
	// A route already seen in the day keeps its own name.
	td2 := ptrace.NewTraces()
	addSpan(td2, ptrace.SpanKindServer, time.Millisecond, attr("http.route", "/r3"))
	if _, ok := a.Traces(td2)[key("/r3", "GET", 0)]; !ok {
		t.Error("known route became {other}")
	}
}

func TestBucketIndex(t *testing.T) {
	cases := map[float64]int{0: 0, 0.005: 0, 0.0051: 1, 0.1: 5, 1: 9, 10: 13, 10.0001: 14, 300: 14}
	for v, want := range cases {
		if got := BucketIndex(v); got != want {
			t.Errorf("BucketIndex(%v) = %d, want %d", v, got, want)
		}
	}
}

func buckets(m map[int]int64) [NumBuckets]int64 {
	var b [NumBuckets]int64
	for i, v := range m {
		b[i] = v
	}
	return b
}

func assertBatch(t *testing.T, got Batch, want map[Key]Point) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("rows = %d, want %d: %v", len(got), len(want), keys(got))
	}
	for k, w := range want {
		p := got[k]
		if p == nil {
			t.Errorf("missing row %+v; got %v", k, keys(got))
			continue
		}
		if p.Count != w.Count || p.Buckets != w.Buckets || diff(p.Sum, w.Sum) > 1e-9 {
			t.Errorf("%s: %+v, want %+v", k.Route, *p, w)
		}
	}
}

func keys(b Batch) []Key {
	var out []Key
	for k := range b {
		out = append(out, k)
	}
	return out
}

func diff(a, b float64) float64 {
	if a > b {
		return a - b
	}
	return b - a
}
