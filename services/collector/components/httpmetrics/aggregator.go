package httpmetrics

import (
	"hash/fnv"
	"math"
	"net/url"
	"slices"
	"strconv"
	"sync"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/romulospl/stellytics/services/collector/components/tenantattr"
)

const (
	// metricPrecedence is the D9 window: with the metric in this period, the
	// service's spans are ignored.
	metricPrecedence = 15 * time.Minute
	// freshProcess is how long, since the StartTimestamp, a new cumulative
	// series counts in full (spec, section 2).
	freshProcess = 5 * time.Minute
	// seriesIdle removes idle cumulative series from memory.
	seriesIdle = time.Hour
	// maxSeries limits the memory of the cumulative series.
	maxSeries = 200_000
)

type service struct{ tenantID, serviceID string }

type routeDay struct {
	day    string
	routes map[string]struct{}
}

// cumulative is the last point seen of a cumulative series.
type cumulative struct {
	start   pcommon.Timestamp
	count   uint64
	sum     float64
	buckets []uint64
	seen    time.Time
}

// Aggregator keeps the state between batches: the last metric of each service
// (D9), the routes of the day (D4) and the cumulative series. All in memory,
// per collector instance.
type Aggregator struct {
	now func() time.Time

	mu         sync.Mutex
	metricSeen map[service]time.Time
	routes     map[service]*routeDay
	series     map[uint64]*cumulative
}

// New creates an Aggregator.
func New() *Aggregator {
	return &Aggregator{
		now:        time.Now,
		metricSeen: make(map[service]time.Time),
		routes:     make(map[service]*routeDay),
		series:     make(map[uint64]*cumulative),
	}
}

// WithClock replaces the clock (for tests) and returns the Aggregator itself.
func (a *Aggregator) WithClock(now func() time.Time) *Aggregator {
	a.now = now
	return a
}

func serviceOf(res pcommon.Resource) (service, bool) {
	attrs := res.Attributes()
	t, ok1 := attrs.Get(tenantattr.AttrTenantID)
	s, ok2 := attrs.Get(tenantattr.AttrServiceID)
	if !ok1 || !ok2 || t.Str() == "" || s.Str() == "" {
		return service{}, false
	}
	return service{t.Str(), s.Str()}, true
}

// Traces extracts the HTTP server spans. Services with a recent metric (D9)
// and spans that are not HTTP server spans are ignored.
func (a *Aggregator) Traces(td ptrace.Traces) Batch {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	out := Batch{}
	for _, rs := range td.ResourceSpans().All() {
		svc, ok := serviceOf(rs.Resource())
		if !ok {
			continue
		}
		if seen, ok := a.metricSeen[svc]; ok && now.Sub(seen) < metricPrecedence {
			continue
		}
		for _, ss := range rs.ScopeSpans().All() {
			for _, sp := range ss.Spans().All() {
				if sp.Kind() != ptrace.SpanKindServer {
					continue
				}
				attrs := sp.Attributes()
				method := str(attrs, "http.request.method", "http.method")
				if method == "" {
					continue
				}
				start, end := sp.StartTimestamp().AsTime(), sp.EndTimestamp().AsTime()
				if end.Before(start) || sp.EndTimestamp() == 0 {
					continue
				}
				dur := end.Sub(start).Seconds()
				bucket := minute(end)
				k := Key{
					Bucket: bucket, TenantID: svc.tenantID, ServiceID: svc.serviceID,
					Route:  a.capRoute(svc, bucket, route(str(attrs, "http.route"), path(attrs))),
					Method: normalizeMethod(method),
					Status: status(attrs),
				}
				var b [NumBuckets]int64
				b[BucketIndex(dur)] = 1
				out.add(k, 1, dur, b)
			}
		}
	}
	return out
}

// Metrics extracts the HTTP server request duration histograms.
func (a *Aggregator) Metrics(md pmetric.Metrics) Batch {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	out := Batch{}
	for _, rm := range md.ResourceMetrics().All() {
		svc, ok := serviceOf(rm.Resource())
		if !ok {
			continue
		}
		resHash := hashMap(rm.Resource().Attributes())
		for _, sm := range rm.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				scale, ok := durationScale(m)
				if !ok || m.Type() != pmetric.MetricTypeHistogram {
					continue
				}
				h := m.Histogram()
				if h.DataPoints().Len() > 0 {
					a.metricSeen[svc] = now
				}
				cumulativeTemp := h.AggregationTemporality() == pmetric.AggregationTemporalityCumulative
				for _, dp := range h.DataPoints().All() {
					count, sum, counts, ok := dp.Count(), dp.Sum(), dp.BucketCounts().AsRaw(), true
					if cumulativeTemp {
						id := seriesID(resHash, m.Name(), dp.Attributes())
						count, sum, counts, ok = a.delta(id, dp, now)
					}
					if !ok || count == 0 {
						continue
					}
					attrs := dp.Attributes()
					bucket := minute(dp.Timestamp().AsTime())
					k := Key{
						Bucket: bucket, TenantID: svc.tenantID, ServiceID: svc.serviceID,
						Route:  a.capRoute(svc, bucket, route(str(attrs, "http.route"), path(attrs))),
						Method: normalizeMethod(str(attrs, "http.request.method", "http.method")),
						Status: status(attrs),
					}
					out.add(k, int64(count), sum*scale, remap(dp.ExplicitBounds().AsRaw(), counts, scale, count, sum*scale))
				}
			}
		}
	}
	return out
}

// durationScale tells whether the metric is the HTTP server request duration
// and the factor to seconds.
func durationScale(m pmetric.Metric) (float64, bool) {
	unit := m.Unit()
	switch m.Name() {
	case "http.server.request.duration":
		if unit == "ms" {
			return 0.001, true
		}
		return 1, true
	case "http.server.duration":
		if unit == "s" {
			return 1, true
		}
		return 0.001, true
	}
	return 0, false
}

// remap maps the source buckets to ours: each source bucket falls into our
// bucket that contains its upper bound (spec, section 2). Without source
// buckets, the mean decides the bucket.
func remap(bounds []float64, counts []uint64, scale float64, count uint64, sum float64) [NumBuckets]int64 {
	var out [NumBuckets]int64
	if len(counts) == 0 || len(counts) != len(bounds)+1 {
		out[BucketIndex(sum/float64(count))] = int64(count)
		return out
	}
	for i, c := range counts {
		ub := math.Inf(1)
		if i < len(bounds) {
			ub = bounds[i] * scale
		}
		out[BucketIndex(ub)] += int64(c)
	}
	return out
}

// delta turns a cumulative point into a delta, with the rule of section 2 of the spec.
func (a *Aggregator) delta(id uint64, dp pmetric.HistogramDataPoint, now time.Time) (uint64, float64, []uint64, bool) {
	cur := &cumulative{start: dp.StartTimestamp(), count: dp.Count(), sum: dp.Sum(), buckets: dp.BucketCounts().AsRaw(), seen: now}
	prev, known := a.series[id]
	if len(a.series) >= maxSeries && !known {
		a.sweepSeries(now)
		if len(a.series) >= maxSeries {
			// No room: it counts only if the process is new, without storing the series.
			return fresh(dp, cur)
		}
	}
	a.series[id] = cur
	if !known {
		return fresh(dp, cur)
	}
	reset := cur.start != prev.start || cur.count < prev.count || len(cur.buckets) != len(prev.buckets)
	if reset {
		return cur.count, cur.sum, cur.buckets, true
	}
	d := make([]uint64, len(cur.buckets))
	for i := range cur.buckets {
		if cur.buckets[i] < prev.buckets[i] {
			return cur.count, cur.sum, cur.buckets, true
		}
		d[i] = cur.buckets[i] - prev.buckets[i]
	}
	return cur.count - prev.count, cur.sum - prev.sum, d, true
}

// fresh counts the first observation of a series only if the process started
// recently; otherwise it only becomes the baseline.
func fresh(dp pmetric.HistogramDataPoint, cur *cumulative) (uint64, float64, []uint64, bool) {
	if dp.StartTimestamp() != 0 && dp.Timestamp().AsTime().Sub(dp.StartTimestamp().AsTime()) <= freshProcess {
		return cur.count, cur.sum, cur.buckets, true
	}
	return 0, 0, nil, false
}

// capRoute applies the route cap per service and day of the bucket (D4).
func (a *Aggregator) capRoute(svc service, bucket time.Time, r string) string {
	day := bucket.Format(time.DateOnly)
	rd := a.routes[svc]
	if rd == nil || rd.day != day {
		if rd != nil && rd.day > day {
			// Late point from an earlier day: it does not reopen the old day.
			return r
		}
		rd = &routeDay{day: day, routes: make(map[string]struct{})}
		a.routes[svc] = rd
	}
	if _, ok := rd.routes[r]; ok {
		return r
	}
	if len(rd.routes) >= MaxRoutesPerDay {
		return RouteOther
	}
	rd.routes[r] = struct{}{}
	return r
}

// Sweep removes from memory what is no longer valid: idle series, services
// without a recent metric and past route days.
func (a *Aggregator) Sweep() {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	a.sweepSeries(now)
	for svc, seen := range a.metricSeen {
		if now.Sub(seen) >= metricPrecedence {
			delete(a.metricSeen, svc)
		}
	}
	yesterday := now.UTC().Add(-24 * time.Hour).Format(time.DateOnly)
	for svc, rd := range a.routes {
		if rd.day < yesterday {
			delete(a.routes, svc)
		}
	}
}

func (a *Aggregator) sweepSeries(now time.Time) {
	for id, s := range a.series {
		if now.Sub(s.seen) >= seriesIdle {
			delete(a.series, id)
		}
	}
}

func str(attrs pcommon.Map, keys ...string) string {
	for _, k := range keys {
		if v, ok := attrs.Get(k); ok && v.AsString() != "" {
			return v.AsString()
		}
	}
	return ""
}

// path finds the request path: url.path, http.target or the path of url.full.
func path(attrs pcommon.Map) string {
	if p := str(attrs, "url.path", "http.target"); p != "" {
		return p
	}
	if full := str(attrs, "url.full", "http.url"); full != "" {
		if u, err := url.Parse(full); err == nil {
			return u.EscapedPath()
		}
	}
	return ""
}

func status(attrs pcommon.Map) int16 {
	for _, k := range []string{"http.response.status_code", "http.status_code"} {
		v, ok := attrs.Get(k)
		if !ok {
			continue
		}
		var n int64
		switch v.Type() {
		case pcommon.ValueTypeInt:
			n = v.Int()
		case pcommon.ValueTypeStr:
			n, _ = strconv.ParseInt(v.Str(), 10, 64)
		}
		if n >= 0 && n <= 999 {
			return int16(n)
		}
	}
	return 0
}

// seriesID identifies a cumulative series: resource, name and point attributes.
func seriesID(resHash uint64, name string, attrs pcommon.Map) uint64 {
	h := fnv.New64a()
	var buf [8]byte
	for i := range buf {
		buf[i] = byte(resHash >> (8 * i))
	}
	h.Write(buf[:])
	h.Write([]byte(name))
	h.Write([]byte{0})
	writeMap(h, attrs)
	return h.Sum64()
}

func hashMap(m pcommon.Map) uint64 {
	h := fnv.New64a()
	writeMap(h, m)
	return h.Sum64()
}

func writeMap(h interface{ Write([]byte) (int, error) }, m pcommon.Map) {
	keys := make([]string, 0, m.Len())
	for k := range m.All() {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		v, _ := m.Get(k)
		h.Write([]byte(k))
		h.Write([]byte{0})
		h.Write([]byte(v.AsString()))
		h.Write([]byte{0})
	}
}
