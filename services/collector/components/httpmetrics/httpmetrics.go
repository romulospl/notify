// Package httpmetrics turns the tenant's OTLP into 1-minute points (#31).
//
// Contract in the E5 spec, sections 2 to 4. Only two inputs become a metric:
// HTTP server spans and http.server.request.duration histograms (or the old
// http.server.duration, in ms). Everything else is dropped. From each request
// only the tenant and the service (from the resource stamped by tenantattr),
// the normalized route, the method, the status and the duration are kept; no
// other attribute leaves this package.
package httpmetrics

import (
	"time"

	"github.com/romulospl/stellytics/services/collector/components/routenorm"
)

// NumBuckets is the size of duration_buckets (spec, section 4, D2).
const NumBuckets = 15

// Bounds are the upper bounds, in seconds, of the first 14 buckets; the last
// one counts what goes over 10 s. Same as the database's api_metric_bounds().
var Bounds = [NumBuckets - 1]float64{0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10}

// Special routes (spec, section 3).
const (
	RouteOther   = "{other}"   // beyond the route cap per service and day (D4)
	RouteUnknown = "{unknown}" // neither http.route nor path
)

// MaxRoutesPerDay is the cap of distinct routes per service and day (D4).
const MaxRoutesPerDay = 500

// MethodOther replaces methods outside the standard HTTP list.
const MethodOther = "_OTHER"

var methods = map[string]bool{
	"GET": true, "HEAD": true, "POST": true, "PUT": true, "DELETE": true,
	"CONNECT": true, "OPTIONS": true, "TRACE": true, "PATCH": true,
}

// Key identifies a row of api_metric_1m.
type Key struct {
	Bucket    time.Time // start of the minute, in UTC
	TenantID  string
	ServiceID string
	Route     string
	Method    string
	Status    int16
}

// Point is what is summed into a row.
type Point struct {
	Count   int64
	Sum     float64 // seconds
	Buckets [NumBuckets]int64
}

// Batch groups the points of a batch by row.
type Batch map[Key]*Point

func (b Batch) add(k Key, count int64, sum float64, buckets [NumBuckets]int64) {
	if count <= 0 {
		return
	}
	p := b[k]
	if p == nil {
		p = &Point{}
		b[k] = p
	}
	p.Count += count
	p.Sum += sum
	for i := range buckets {
		p.Buckets[i] += buckets[i]
	}
}

// BucketIndex returns the bucket of a duration in seconds.
func BucketIndex(seconds float64) int {
	for i, ub := range Bounds {
		if seconds <= ub {
			return i
		}
	}
	return NumBuckets - 1
}

func normalizeMethod(m string) string {
	if methods[m] {
		return m
	}
	return MethodOther
}

func route(httpRoute, path string) string {
	if httpRoute == "" && path == "" {
		return RouteUnknown
	}
	return routenorm.Route(httpRoute, path)
}

func minute(t time.Time) time.Time {
	return t.UTC().Truncate(time.Minute)
}
