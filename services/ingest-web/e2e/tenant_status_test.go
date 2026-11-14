//go:build e2e

package e2e

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Tenant removido (#20, #21; spec do E2, seções 6 e 8): o gateway continua
// respondendo 204, mas o evento não chega ao Umami. Depois de reativado, volta
// a chegar. O status muda direto no banco, como faz a ação do operador no
// portal (testada em apps/portal/test/isolation.test.ts); aqui o que importa é
// o caminho do gateway até o Umami, com o cache de SITE_CACHE_TTL.
func TestRemovedTenantIsDropped(t *testing.T) {
	token := umamiLogin(t)
	websiteID := umamiCreateWebsite(t, token)
	t.Cleanup(func() { umamiDo(t, token, http.MethodDelete, "/api/websites/"+websiteID, nil, nil) })

	db := connect(t, notifyDB)
	registerSite(t, db, websiteID)
	time.Sleep(siteCacheTTL + time.Second)
	start := time.Now().Add(-time.Minute)

	send := func(path string) {
		t.Helper()
		if code := sendEvent(t, websiteID, path); code != http.StatusNoContent {
			t.Fatalf("page view %s: status = %d, quero 204", path, code)
		}
	}

	send("/ativo")
	waitPageviews(t, token, websiteID, start, 1)

	setTenantStatus(t, db, websiteID, "removed")
	time.Sleep(siteCacheTTL + time.Second)
	// Mesma resposta do sucesso, para não dar pista a quem testa IDs.
	send("/removido")

	setTenantStatus(t, db, websiteID, "active")
	time.Sleep(siteCacheTTL + time.Second)
	send("/reativado")

	// Os dois eventos aceitos chegam; o do tenant removido não.
	waitPageviews(t, token, websiteID, start, 2)
	time.Sleep(3 * time.Second)
	if views := umamiPageviews(t, token, websiteID, start); views != 2 {
		t.Fatalf("pageviews = %d, quero 2 (o evento do tenant removido chegou ao Umami?)", views)
	}
}

func setTenantStatus(t *testing.T, db *pgx.Conn, websiteID, status string) {
	t.Helper()
	tag, err := db.Exec(context.Background(),
		`UPDATE tenant SET status = $2, status_changed_at = now()
		 WHERE id = (SELECT tenant_id FROM site WHERE umami_website_id = $1)`, websiteID, status)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("tenant do site %s não encontrado", websiteID)
	}
}

// waitPageviews espera o Umami contar `want` page views; falha se passar disso.
func waitPageviews(t *testing.T, token, websiteID string, since time.Time, want int) {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for {
		views := umamiPageviews(t, token, websiteID, since)
		if views == want {
			return
		}
		if views > want {
			t.Fatalf("pageviews = %d, quero %d", views, want)
		}
		if time.Now().After(deadline) {
			t.Fatalf("pageviews = %d depois de 90 s, quero %d", views, want)
		}
		time.Sleep(time.Second)
	}
}
