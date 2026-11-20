package ingestkeyauth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/collector/client"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

const (
	validKey = "ntf_abcdefgh_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"
	tenantID = "6f1c2b9e-3a4d-4c8e-9f00-1234567890ab"
	service  = "0a0b0c0d-0e0f-4000-8000-000000000001"
)

// fakeStore holds keys by prefix and counts the lookups.
type fakeStore struct {
	keys  map[string]Key
	err   error
	calls atomic.Int32
}

func (f *fakeStore) Lookup(_ context.Context, prefix string) (Key, bool, error) {
	f.calls.Add(1)
	if f.err != nil {
		return Key{}, false, f.err
	}
	k, ok := f.keys[prefix]
	return k, ok, nil
}

func newStore() *fakeStore {
	h := sha256.Sum256([]byte(validKey))
	return &fakeStore{keys: map[string]Key{"abcdefgh": {Hash: h[:], TenantID: tenantID, ServiceID: service}}}
}

func header(name, value string) map[string][]string { return map[string][]string{name: {value}} }

func TestAuthenticateValidKey(t *testing.T) {
	a := newAuthenticator(newStore(), time.Minute, zap.NewNop())
	// HTTP sends the header in canonical form; gRPC, in lowercase.
	for _, name := range []string{"Authorization", "authorization"} {
		ctx, err := a.Authenticate(context.Background(), header(name, "Bearer "+validKey))
		if err != nil {
			t.Fatalf("%s: valid key refused: %v", name, err)
		}
		auth := client.FromContext(ctx).Auth
		if auth == nil || auth.GetAttribute(AttrTenantID) != tenantID || auth.GetAttribute(AttrServiceID) != service ||
			auth.GetAttribute(AttrPrefix) != "abcdefgh" {
			t.Fatalf("%s: auth = %#v", name, auth)
		}
	}
}

func TestAuthenticateRejects(t *testing.T) {
	wrongSecret := validKey[:len(validKey)-1] + "H"
	cases := map[string]map[string][]string{
		"no header":      {},
		"no Bearer":      header("Authorization", validKey),
		"other scheme":   header("Authorization", "Basic "+validKey),
		"wrong format":   header("Authorization", "Bearer ntf_ABCDEFGH_x"),
		"wrong secret":   header("Authorization", "Bearer "+wrongSecret),
		"unknown prefix": header("Authorization", "Bearer ntf_zzzzzzzz_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"),
		"SCF read key":   header("Authorization", "Bearer nrk_abcdefgh_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"),
		"two values":     {"Authorization": {"Bearer " + validKey, "Bearer " + validKey}},
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			a := newAuthenticator(newStore(), time.Minute, zap.NewNop())
			ctx, err := a.Authenticate(context.Background(), h)
			if !errors.Is(err, errUnauthenticated) {
				t.Fatalf("err = %v, want errUnauthenticated", err)
			}
			if client.FromContext(ctx).Auth != nil {
				t.Error("refused context carried authentication data")
			}
		})
	}
}

func TestCache(t *testing.T) {
	store := newStore()
	now := time.Unix(1_800_000_000, 0)
	a := newAuthenticator(store, time.Minute, zap.NewNop())
	a.now = func() time.Time { return now }
	auth := func(key string) error {
		_, err := a.Authenticate(context.Background(), header("Authorization", "Bearer "+key))
		return err
	}
	wrongSecret := validKey[:len(validKey)-1] + "H"

	for range 3 {
		if err := auth(validKey); err != nil {
			t.Fatal(err)
		}
		if auth(wrongSecret) == nil {
			t.Fatal("wrong secret accepted")
		}
	}
	if n := store.calls.Load(); n != 2 {
		t.Errorf("database lookups = %d, want 2 (positive and negative cached)", n)
	}

	// Revoked: gone from the view. Takes effect when the cache expires (at most 60 s, #59).
	delete(store.keys, "abcdefgh")
	if err := auth(validKey); err != nil {
		t.Error("cache expired before the TTL")
	}
	now = now.Add(time.Minute + time.Second)
	if auth(validKey) == nil {
		t.Error("revoked key still accepted after the TTL")
	}
}

func TestStoreErrorIsNotCached(t *testing.T) {
	store := newStore()
	store.err = errors.New("database down")
	a := newAuthenticator(store, time.Minute, zap.NewNop())
	if _, err := a.Authenticate(context.Background(), header("Authorization", "Bearer "+validKey)); err == nil {
		t.Fatal("accepted with the database down")
	}
	store.err = nil
	if _, err := a.Authenticate(context.Background(), header("Authorization", "Bearer "+validKey)); err != nil {
		t.Fatalf("database error was cached: %v", err)
	}
}

func TestConfigValidate(t *testing.T) {
	cases := map[string]struct {
		cfg Config
		ok  bool
	}{
		"default with database": {Config{DatabaseURL: "postgres://x", CacheTTL: time.Minute}, true},
		"no cache":              {Config{DatabaseURL: "postgres://x"}, true},
		"no database":           {Config{CacheTTL: time.Minute}, false},
		"cache above 60s":       {Config{DatabaseURL: "postgres://x", CacheTTL: 2 * time.Minute}, false},
	}
	for name, c := range cases {
		if err := c.cfg.Validate(); (err == nil) != c.ok {
			t.Errorf("%s: Validate = %v", name, err)
		}
	}
}

func clientAuth(ctx context.Context) client.AuthData {
	if a := client.FromContext(ctx).Auth; a != nil {
		return a
	}
	return authData{}
}

// touchStore adds the last-use record to the fakeStore.
type touchStore struct {
	*fakeStore
	touched chan string
	err     error
}

func (s *touchStore) Touch(_ context.Context, prefix string) error {
	s.touched <- prefix
	return s.err
}

func waitTouch(t *testing.T, s *touchStore, wait ...time.Duration) bool {
	t.Helper()
	d := 2 * time.Second
	if len(wait) > 0 {
		d = wait[0]
	}
	select {
	case <-s.touched:
		return true
	case <-time.After(d):
		return false
	}
}

func TestTouchOncePerDay(t *testing.T) {
	s := &touchStore{fakeStore: newStore(), touched: make(chan string, 10)}
	a := newAuthenticator(s, time.Nanosecond, zap.NewNop())
	now := time.Date(2026, 11, 15, 23, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return now }
	auth := func() {
		t.Helper()
		if _, err := a.Authenticate(context.Background(), header("Authorization", "Bearer "+validKey)); err != nil {
			t.Fatal(err)
		}
	}

	auth()
	if !waitTouch(t, s) {
		t.Fatal("first authentication of the day did not write")
	}
	now = now.Add(30 * time.Minute) // still the 15th
	auth()
	auth()
	if waitTouch(t, s, 100*time.Millisecond) {
		t.Fatal("wrote again on the same day")
	}
	now = now.Add(time.Hour) // the 16th
	auth()
	if !waitTouch(t, s) {
		t.Fatal("did not write on the next day")
	}
}

// lockedBuffer lets the recording goroutine and the test use the same buffer.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func TestTouchRetriesAfterFailureAndIgnoresRejected(t *testing.T) {
	s := &touchStore{fakeStore: newStore(), touched: make(chan string, 10), err: errors.New("boom with ntf_secret")}
	var logs lockedBuffer
	core := zapcore.NewCore(zapcore.NewJSONEncoder(zap.NewProductionEncoderConfig()), zapcore.AddSync(&logs), zapcore.WarnLevel)
	a := newAuthenticator(s, time.Nanosecond, zap.New(core))
	now := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return now }

	// A refused key never writes.
	bad := "ntf_abcdefgh_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	if _, err := a.Authenticate(context.Background(), header("Authorization", "Bearer "+bad)); err == nil {
		t.Fatal("wrong key accepted")
	}
	if waitTouch(t, s, 100*time.Millisecond) {
		t.Fatal("refused key wrote")
	}

	if _, err := a.Authenticate(context.Background(), header("Authorization", "Bearer "+validKey)); err != nil {
		t.Fatal(err)
	}
	if !waitTouch(t, s) {
		t.Fatal("did not write")
	}
	// The goroutine reschedules the retry after the failure: wait, under the
	// authenticator's mutex, for the allowed date to become now + touchRetry.
	want := now.Add(touchRetry)
	deadline := time.Now().Add(2 * time.Second)
	for {
		a.mu.Lock()
		got := a.nextTouch["abcdefgh"]
		a.mu.Unlock()
		if got.Equal(want) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("retry was not rescheduled: %s, want %s", got, want)
		}
		time.Sleep(time.Millisecond)
	}
	now = now.Add(time.Minute)
	_, _ = a.Authenticate(context.Background(), header("Authorization", "Bearer "+validKey))
	if waitTouch(t, s, 100*time.Millisecond) {
		t.Fatal("tried again before the interval")
	}
	now = now.Add(6 * time.Minute)
	_, _ = a.Authenticate(context.Background(), header("Authorization", "Bearer "+validKey))
	if !waitTouch(t, s) {
		t.Fatal("did not try again after the interval")
	}
	if strings.Contains(logs.String(), "ntf_") || strings.Contains(logs.String(), "secret") {
		t.Fatalf("log leaked the key or the error message: %s", logs.String())
	}
	if !strings.Contains(logs.String(), "*errors.errorString") {
		t.Fatalf("log without the error name: %s", logs.String())
	}
}
