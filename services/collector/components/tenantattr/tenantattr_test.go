package tenantattr

import (
	"context"
	"testing"

	"go.opentelemetry.io/collector/consumer/consumererror"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/processor/processortest"
)

// Without going through the authentication extension, nothing moves on in the pipeline.
func TestRejectsUnauthenticated(t *testing.T) {
	sink := new(consumertest.MetricsSink)
	p, err := NewFactory().CreateMetrics(context.Background(), processortest.NewNopSettings(Type), &Config{}, sink)
	if err != nil {
		t.Fatal(err)
	}
	md := pmetric.NewMetrics()
	md.ResourceMetrics().AppendEmpty().Resource().Attributes().PutStr(AttrTenantID, "forged")
	err = p.ConsumeMetrics(context.Background(), md)
	if !consumererror.IsPermanent(err) {
		t.Fatalf("err = %v, want permanent error", err)
	}
	if sink.DataPointCount() != 0 || len(sink.AllMetrics()) != 0 {
		t.Error("unauthenticated data moved on in the pipeline")
	}
}
