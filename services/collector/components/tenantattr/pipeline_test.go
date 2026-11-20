package tenantattr_test

// Whole path in process (#30): real OTLP receiver (HTTP and gRPC) with the
// ingestkeyauth extension, the tenantattr processor and a test consumer.
// Checks that the key sets the tenant and the service, over whatever the
// client sends, and that an invalid key is refused with 401 / Unauthenticated.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"net"
	"net/http"
	"testing"
	"time"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/confmap"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
	"go.opentelemetry.io/collector/processor/processortest"
	"go.opentelemetry.io/collector/receiver/otlpreceiver"
	"go.opentelemetry.io/collector/receiver/receivertest"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/romulospl/stellytics/services/collector/components/ingestkeyauth"
	"github.com/romulospl/stellytics/services/collector/components/tenantattr"
)

const (
	key      = "ntf_abcdefgh_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"
	tenantID = "6f1c2b9e-3a4d-4c8e-9f00-1234567890ab"
	service  = "0a0b0c0d-0e0f-4000-8000-000000000001"
)

type store struct{}

func (store) Lookup(_ context.Context, prefix string) (ingestkeyauth.Key, bool, error) {
	if prefix != "abcdefgh" {
		return ingestkeyauth.Key{}, false, nil
	}
	h := sha256.Sum256([]byte(key))
	return ingestkeyauth.Key{Hash: h[:], TenantID: tenantID, ServiceID: service}, true, nil
}

// authExt wraps the authenticator as a collector extension.
type authExt struct {
	auth interface {
		Authenticate(context.Context, map[string][]string) (context.Context, error)
	}
}

func (authExt) Start(context.Context, component.Host) error { return nil }
func (authExt) Shutdown(context.Context) error              { return nil }
func (e authExt) Authenticate(ctx context.Context, h map[string][]string) (context.Context, error) {
	return e.auth.Authenticate(ctx, h)
}

type host struct {
	exts map[component.ID]component.Component
}

func (h host) GetExtensions() map[component.ID]component.Component { return h.exts }

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().String()
}

// start brings up receiver -> tenantattr -> sink and returns the gRPC and HTTP addresses.
func start(t *testing.T) (sink *consumertest.TracesSink, grpcAddr, httpAddr string) {
	t.Helper()
	ctx := context.Background()
	sink = new(consumertest.TracesSink)

	proc, err := tenantattr.NewFactory().CreateTraces(ctx, processortest.NewNopSettings(tenantattr.Type), &tenantattr.Config{}, sink)
	if err != nil {
		t.Fatal(err)
	}

	grpcAddr, httpAddr = freeAddr(t), freeAddr(t)
	factory := otlpreceiver.NewFactory()
	cfg := factory.CreateDefaultConfig()
	auth := map[string]any{"authenticator": "ingestkeyauth"}
	err = confmap.NewFromStringMap(map[string]any{"protocols": map[string]any{
		"grpc": map[string]any{"endpoint": grpcAddr, "auth": auth},
		"http": map[string]any{"endpoint": httpAddr, "auth": auth},
	}}).Unmarshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	rcv, err := factory.CreateTraces(ctx, receivertest.NewNopSettings(factory.Type()), cfg, proc)
	if err != nil {
		t.Fatal(err)
	}

	h := host{exts: map[component.ID]component.Component{
		component.NewID(ingestkeyauth.Type): authExt{ingestkeyauth.NewAuthenticator(store{}, time.Minute, zap.NewNop())},
	}}
	for _, c := range []component.Component{proc, rcv} {
		if err := c.Start(ctx, h); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Shutdown(context.Background()) })
	}
	return sink, grpcAddr, httpAddr
}

// traces builds a span whose resource tries to pass as another tenant.
func traces() ptrace.Traces {
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.name", "api")
	rs.Resource().Attributes().PutStr("tenant.id", "other-tenant")
	rs.Resource().Attributes().PutStr(tenantattr.AttrTenantID, "other-tenant")
	rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty().SetName("GET /ledgers/{id}")
	return td
}

func checkStamped(t *testing.T, sink *consumertest.TracesSink) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for sink.SpanCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	all := sink.AllTraces()
	if len(all) != 1 {
		t.Fatalf("batches received = %d, want 1", len(all))
	}
	attrs := all[0].ResourceSpans().At(0).Resource().Attributes()
	got := map[string]string{}
	attrs.Range(func(k string, v pcommon.Value) bool { got[k] = v.AsString(); return true })
	want := map[string]string{
		"service.name":           "api",
		tenantattr.AttrTenantID:  tenantID,
		tenantattr.AttrServiceID: service,
	}
	if len(got) != len(want) {
		t.Fatalf("attributes = %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}

func postHTTP(t *testing.T, addr, auth string) int {
	t.Helper()
	body, err := ptraceotlp.NewExportRequestFromTraces(traces()).MarshalProto()
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodPost, "http://"+addr+"/v1/traces", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/x-protobuf")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func exportGRPC(t *testing.T, addr, auth string) error {
	t.Helper()
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if auth != "" {
		ctx = metadata.AppendToOutgoingContext(ctx, "authorization", auth)
	}
	_, err = ptraceotlp.NewGRPCClient(conn).Export(ctx, ptraceotlp.NewExportRequestFromTraces(traces()))
	return err
}

func TestHTTP(t *testing.T) {
	sink, _, addr := start(t)
	for _, auth := range []string{"", "Bearer ntf_abcdefgh_" + "x", "Bearer " + key[:len(key)-1] + "H"} {
		if code := postHTTP(t, addr, auth); code != http.StatusUnauthorized {
			t.Errorf("Authorization %q: status = %d, want 401", auth, code)
		}
	}
	if sink.SpanCount() != 0 {
		t.Fatal("refused request reached the pipeline")
	}
	if code := postHTTP(t, addr, "Bearer "+key); code != http.StatusOK {
		t.Fatalf("valid key: status = %d, want 200", code)
	}
	checkStamped(t, sink)
}

func TestGRPC(t *testing.T) {
	sink, addr, _ := start(t)
	for _, auth := range []string{"", "Bearer " + key[:len(key)-1] + "H"} {
		if err := exportGRPC(t, addr, auth); status.Code(err) != codes.Unauthenticated {
			t.Errorf("authorization %q: %v, want Unauthenticated", auth, err)
		}
	}
	if sink.SpanCount() != 0 {
		t.Fatal("refused request reached the pipeline")
	}
	if err := exportGRPC(t, addr, "Bearer "+key); err != nil {
		t.Fatalf("valid key: %v", err)
	}
	checkStamped(t, sink)
}
