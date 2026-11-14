//go:build e2e

// Isolamento entre tenants na ingestão de API (#20 e #21; spec do E2, seções
// 6 e 8): mudanças feitas DEPOIS que a chave já foi aceita valem em até o
// cache do coletor (INGEST_KEY_CACHE_TTL: no máximo 60 s, 5 s no Compose).
//
//   - chave revogada: passa a ser recusada;
//   - tenant removido pelo operador: a chave dele passa a ser recusada, e volta
//     a valer quando o tenant é reativado (D6).
//
// O status muda direto no banco, como fazem as funções do portal (testadas em
// apps/portal/test/isolation.test.ts). A recusa é 401 (HTTP) e Unauthenticated
// (gRPC), a mesma de uma chave inexistente.
package e2e

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// keyCacheTTL é o INGEST_KEY_CACHE_TTL do coletor no Compose.
var keyCacheTTL = func() time.Duration {
	d, err := time.ParseDuration(env("COLLECTOR_KEY_CACHE_TTL", "5s"))
	if err != nil {
		panic(err)
	}
	return d
}()

func TestRevokedKeyIsRefusedWithinCacheTTL(t *testing.T) {
	db, user := isolationDB(t)
	key := createKey(t, db, user, "active")
	expectAccepted(t, key)

	exec(t, db, `UPDATE ingest_key SET revoked_at = now() WHERE prefix = $1`, prefixOf(key))
	time.Sleep(keyCacheTTL + time.Second)
	expectRefused(t, key)
}

func TestRemovedTenantIsRefusedWithinCacheTTL(t *testing.T) {
	db, user := isolationDB(t)
	key := createKey(t, db, user, "active")
	other := createKey(t, db, user, "active")
	expectAccepted(t, key)

	setTenantStatus(t, db, key, "removed")
	time.Sleep(keyCacheTTL + time.Second)
	expectRefused(t, key)
	// Os outros tenants continuam.
	expectAccepted(t, other)

	setTenantStatus(t, db, key, "active")
	time.Sleep(keyCacheTTL + time.Second)
	expectAccepted(t, key)
}

func isolationDB(t *testing.T) (*pgx.Conn, string) {
	t.Helper()
	ctx := context.Background()
	db, err := pgx.Connect(ctx, notifyDB)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close(context.Background()) })
	user := randomText(t, 16)
	exec(t, db, `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'e2e', $1 || '@collector.invalid', true)`, user)
	// Depois das chaves e dos tenants (createKey registra a limpeza deles depois,
	// então ela roda antes desta).
	t.Cleanup(func() { _, _ = db.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, user) })
	return db, user
}

// prefixOf tira o prefixo público de ntf_<prefixo>_<segredo>.
func prefixOf(key string) string { return key[4:12] }

func setTenantStatus(t *testing.T, db *pgx.Conn, key, status string) {
	t.Helper()
	tag, err := db.Exec(context.Background(),
		`UPDATE tenant SET status = $2, status_changed_at = now()
		 WHERE id = (SELECT tenant_id FROM ingest_key WHERE prefix = $1)`, prefixOf(key), status)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("tenant da chave %s não encontrado", prefixOf(key))
	}
}

func expectAccepted(t *testing.T, key string) {
	t.Helper()
	if code := postHTTP(t, "Bearer "+key); code != http.StatusOK {
		t.Fatalf("HTTP: status = %d, quero 200", code)
	}
	if err := exportGRPC(t, "Bearer "+key); err != nil {
		t.Fatalf("gRPC: chave recusada: %v", err)
	}
}

func expectRefused(t *testing.T, key string) {
	t.Helper()
	if code := postHTTP(t, "Bearer "+key); code != http.StatusUnauthorized {
		t.Fatalf("HTTP: status = %d, quero 401", code)
	}
	if err := exportGRPC(t, "Bearer "+key); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("gRPC: err = %v, quero Unauthenticated", err)
	}
}
