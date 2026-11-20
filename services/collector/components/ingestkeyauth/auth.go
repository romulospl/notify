// Package ingestkeyauth is the collector's authentication extension (#30).
//
// Contract in the E2 spec, section 5, and in the E5 spec, section 1. The client
// sends the ingest key in "Authorization: Bearer ntf_<prefix>_<secret>" over
// OTLP (HTTP or gRPC). The extension looks the key up by prefix in the
// ingest_key_active view (user stellytics_collector), compares the SHA-256 in
// constant time and puts the key's tenant and service in the request context.
// No attribute sent by the client changes that. A key that is invalid, revoked,
// of an archived service or of a tenant that is not active is refused: the
// receiver answers 401 (HTTP) or Unauthenticated (gRPC).
package ingestkeyauth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/extension/extensionauth"
	"go.uber.org/zap"
)

// Attributes the extension puts in client.Info.Auth.
const (
	AttrTenantID  = "tenant.id"
	AttrServiceID = "api_service.id"
	AttrPrefix    = "ingest_key.prefix"
)

// keyPattern is the key format (E2 spec, section 5).
var keyPattern = regexp.MustCompile(`^ntf_([a-z2-7]{8})_[A-Za-z0-9_-]{43}$`)

// errUnauthenticated is the only refusal response, so as not to hint at which
// part of the key was wrong.
var errUnauthenticated = errors.New("invalid ingest key")

// maxCached limits the cache, which also holds negative answers.
const maxCached = 10_000

// Key is an active key as the ingest_key_active view returns it.
type Key struct {
	Hash      []byte
	TenantID  string
	ServiceID string
}

// Store looks up the active key by prefix. ok is false when there is no
// active key with that prefix.
type Store interface {
	Lookup(ctx context.Context, prefix string) (key Key, ok bool, err error)
}

// Toucher records the last use of an active key (ingest_key.last_used_on).
// The Postgres Store implements it; a Store without Touch simply does not write.
type Toucher interface {
	Touch(ctx context.Context, prefix string) error
}

const (
	// touchTimeout limits the background write.
	touchTimeout = 5 * time.Second
	// touchRetry is how long to wait before trying again after a failure.
	touchRetry = 5 * time.Minute
)

// authenticator implements extensionauth.Server.
type authenticator struct {
	store  Store
	ttl    time.Duration
	now    func() time.Time
	logger *zap.Logger

	mu    sync.Mutex
	cache map[[sha256.Size]byte]entry
	// nextTouch holds, per prefix, when the next last-use record is allowed:
	// the start of the next UTC day after a success, or touchRetry after a
	// failure. Only authenticated keys get in here, so the map does not grow
	// with invalid traffic.
	nextTouch map[string]time.Time
}

type entry struct {
	key     Key
	ok      bool
	expires time.Time
}

// NewAuthenticator creates the authenticator over any Store. The extension
// uses the Postgres Store; the tests, an in-memory Store.
func NewAuthenticator(store Store, ttl time.Duration, logger *zap.Logger) extensionauth.Server {
	return newAuthenticator(store, ttl, logger)
}

func newAuthenticator(store Store, ttl time.Duration, logger *zap.Logger) *authenticator {
	return &authenticator{store: store, ttl: ttl, now: time.Now, logger: logger, cache: make(map[[sha256.Size]byte]entry), nextTouch: make(map[string]time.Time)}
}

// Authenticate validates the key and returns the context with the tenant and the service.
func (a *authenticator) Authenticate(ctx context.Context, headers map[string][]string) (context.Context, error) {
	raw, ok := bearer(headers)
	if !ok {
		return ctx, errUnauthenticated
	}
	m := keyPattern.FindStringSubmatch(raw)
	if m == nil {
		return ctx, errUnauthenticated
	}
	prefix := m[1]
	hash := sha256.Sum256([]byte(raw))

	key, ok, err := a.lookup(ctx, prefix, hash)
	if err != nil {
		// Only the prefix goes to the log; the full key never does.
		a.logger.Error("ingest_key_active lookup failed", zap.String("prefix", prefix), zap.Error(err))
		return ctx, errUnauthenticated
	}
	if !ok {
		return ctx, errUnauthenticated
	}

	a.touch(prefix)

	info := client.FromContext(ctx)
	info.Auth = authData{tenantID: key.TenantID, serviceID: key.ServiceID, prefix: prefix}
	return client.NewContext(ctx, info), nil
}

// touch records the key's last use in the background, at most once per key
// and per UTC day in this process. Off the request path: the request neither
// waits for nor sees the result. A failure only becomes a log with the error
// name (never the key, nor the driver's message) and a retry after touchRetry.
func (a *authenticator) touch(prefix string) {
	toucher, ok := a.store.(Toucher)
	if !ok {
		return
	}
	now := a.now()
	a.mu.Lock()
	if next, seen := a.nextTouch[prefix]; seen && now.Before(next) {
		a.mu.Unlock()
		return
	}
	if len(a.nextTouch) >= maxCached {
		clear(a.nextTouch)
	}
	a.nextTouch[prefix] = nextUTCDay(now)
	a.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), touchTimeout)
		defer cancel()
		if err := toucher.Touch(ctx, prefix); err != nil {
			a.logger.Warn("recording the key's last use failed", zap.String("prefix", prefix), zap.String("error", fmt.Sprintf("%T", err)))
			a.mu.Lock()
			a.nextTouch[prefix] = now.Add(touchRetry)
			a.mu.Unlock()
		}
	}()
}

// nextUTCDay is the start of the UTC day after t.
func nextUTCDay(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d+1, 0, 0, 0, 0, time.UTC)
}

// lookup checks the cache by the hash of the full key and, without a valid
// cached answer, the database. Database errors are not cached.
func (a *authenticator) lookup(ctx context.Context, prefix string, hash [sha256.Size]byte) (Key, bool, error) {
	now := a.now()
	a.mu.Lock()
	e, cached := a.cache[hash]
	a.mu.Unlock()
	if cached && now.Before(e.expires) {
		return e.key, e.ok, nil
	}

	key, found, err := a.store.Lookup(ctx, prefix)
	if err != nil {
		return Key{}, false, err
	}
	ok := found && subtle.ConstantTimeCompare(key.Hash, hash[:]) == 1
	if !ok {
		key = Key{}
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.cache) >= maxCached {
		for k, v := range a.cache {
			if !now.Before(v.expires) {
				delete(a.cache, k)
			}
		}
		if len(a.cache) >= maxCached {
			clear(a.cache)
		}
	}
	a.cache[hash] = entry{key: key, ok: ok, expires: now.Add(a.ttl)}
	return key, ok, nil
}

// bearer finds the "Authorization: Bearer <key>". Over HTTP the header comes
// in canonical form; over gRPC, the metadata comes in lowercase.
func bearer(headers map[string][]string) (string, bool) {
	for name, values := range headers {
		if !strings.EqualFold(name, "authorization") || len(values) != 1 {
			continue
		}
		scheme, token, found := strings.Cut(values[0], " ")
		if found && strings.EqualFold(scheme, "bearer") && token != "" {
			return strings.TrimSpace(token), true
		}
	}
	return "", false
}

// authData is what stays in client.Info.Auth for the following components.
type authData struct {
	tenantID, serviceID, prefix string
}

func (d authData) GetAttribute(name string) any {
	switch name {
	case AttrTenantID:
		return d.tenantID
	case AttrServiceID:
		return d.serviceID
	case AttrPrefix:
		return d.prefix
	}
	return nil
}

func (authData) GetAttributeNames() []string {
	return []string{AttrTenantID, AttrServiceID, AttrPrefix}
}
