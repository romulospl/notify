package ingestkeyauth

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// pgStore reads the ingest_key_active view (E2 spec, section 4) with the
// stellytics_collector user, which only has SELECT on it.
type pgStore struct {
	pool *pgxpool.Pool
}

func (s pgStore) Lookup(ctx context.Context, prefix string) (Key, bool, error) {
	var k Key
	err := s.pool.QueryRow(ctx,
		`SELECT key_hash, tenant_id::text, api_service_id::text FROM ingest_key_active WHERE prefix = $1`, prefix,
	).Scan(&k.Hash, &k.TenantID, &k.ServiceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Key{}, false, nil
	}
	if err != nil {
		return Key{}, false, err
	}
	return k, true, nil
}

// Touch calls ingest_key_touch (migration 0008), the only write
// stellytics_collector can make to ingest_key: it stores today's date (UTC) in
// last_used_on, only for an active key and only if the date changed.
func (s pgStore) Touch(ctx context.Context, prefix string) error {
	var updated bool
	return s.pool.QueryRow(ctx, `SELECT ingest_key_touch($1)`, prefix).Scan(&updated)
}
