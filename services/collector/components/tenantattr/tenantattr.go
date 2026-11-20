// Package tenantattr stamps the ingest key's tenant and service on each
// resource that enters the collector (#30, E5 spec, section 1).
//
// The value comes from client.Info.Auth, filled in by the ingestkeyauth
// extension; whatever the client sends in the resource attributes with these
// names is erased first. That is why this processor must come before batch,
// which loses the request context. Unauthenticated data never gets past here.
package tenantattr

import (
	"context"
	"errors"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/consumer/consumererror"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/processor"
	"go.opentelemetry.io/collector/processor/processorhelper"

	"github.com/romulospl/stellytics/services/collector/components/ingestkeyauth"
)

// Resource attributes the processor sets. The following components (the
// exporter of #31) read only these.
const (
	AttrTenantID  = "stellytics.tenant.id"
	AttrServiceID = "stellytics.api_service.id"
)

// spoofable are resource attributes the client could send to pass as another
// tenant or service. All are removed before the stamp.
var spoofable = []string{AttrTenantID, AttrServiceID, "tenant.id", "tenant_id"}

// Type is the processor's name in the collector configuration.
var Type = component.MustNewType("tenantattr")

// errNoAuth: the pipeline received data without going through the authentication extension.
var errNoAuth = errors.New("tenantattr: request without an authenticated tenant; the receiver must use the ingestkeyauth extension")

// Config has no fields.
type Config struct{}

// NewFactory creates the processor's factory.
func NewFactory() processor.Factory {
	return processor.NewFactory(Type, func() component.Config { return &Config{} },
		processor.WithTraces(createTraces, component.StabilityLevelDevelopment),
		processor.WithMetrics(createMetrics, component.StabilityLevelDevelopment),
		processor.WithLogs(createLogs, component.StabilityLevelDevelopment),
	)
}

var mutates = processorhelper.WithCapabilities(consumer.Capabilities{MutatesData: true})

func createTraces(ctx context.Context, set processor.Settings, cfg component.Config, next consumer.Traces) (processor.Traces, error) {
	return processorhelper.NewTraces(ctx, set, cfg, next, func(ctx context.Context, td ptrace.Traces) (ptrace.Traces, error) {
		rs := td.ResourceSpans()
		return td, stamp(ctx, rs.Len(), func(i int) pcommon.Resource { return rs.At(i).Resource() })
	}, mutates)
}

func createMetrics(ctx context.Context, set processor.Settings, cfg component.Config, next consumer.Metrics) (processor.Metrics, error) {
	return processorhelper.NewMetrics(ctx, set, cfg, next, func(ctx context.Context, md pmetric.Metrics) (pmetric.Metrics, error) {
		rm := md.ResourceMetrics()
		return md, stamp(ctx, rm.Len(), func(i int) pcommon.Resource { return rm.At(i).Resource() })
	}, mutates)
}

func createLogs(ctx context.Context, set processor.Settings, cfg component.Config, next consumer.Logs) (processor.Logs, error) {
	return processorhelper.NewLogs(ctx, set, cfg, next, func(ctx context.Context, ld plog.Logs) (plog.Logs, error) {
		rl := ld.ResourceLogs()
		return ld, stamp(ctx, rl.Len(), func(i int) pcommon.Resource { return rl.At(i).Resource() })
	}, mutates)
}

// stamp replaces each resource's tenant and service attributes with the key's.
func stamp(ctx context.Context, n int, resource func(int) pcommon.Resource) error {
	tenantID, serviceID, ok := fromAuth(ctx)
	if !ok {
		return consumererror.NewPermanent(errNoAuth)
	}
	for i := 0; i < n; i++ {
		attrs := resource(i).Attributes()
		for _, k := range spoofable {
			attrs.Remove(k)
		}
		attrs.PutStr(AttrTenantID, tenantID)
		attrs.PutStr(AttrServiceID, serviceID)
	}
	return nil
}

func fromAuth(ctx context.Context) (tenantID, serviceID string, ok bool) {
	auth := client.FromContext(ctx).Auth
	if auth == nil {
		return "", "", false
	}
	tenantID, _ = auth.GetAttribute(ingestkeyauth.AttrTenantID).(string)
	serviceID, _ = auth.GetAttribute(ingestkeyauth.AttrServiceID).(string)
	return tenantID, serviceID, tenantID != "" && serviceID != ""
}
