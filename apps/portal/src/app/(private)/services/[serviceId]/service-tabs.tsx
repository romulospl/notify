import Link from "next/link";

// Abas de um serviço de API: o painel (#37) e as chaves de ingestão (#59).
export function ServiceTabs({ serviceId, current }: { serviceId: string; current: "overview" | "keys" }) {
  const tabs = [
    { key: "overview", label: "Overview", href: `/services/${serviceId}` },
    { key: "keys", label: "Ingest keys", href: `/services/${serviceId}/keys` },
  ] as const;
  return (
    <nav aria-label="Service" className="mt-4 flex gap-4 border-b border-border text-sm">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={
            t.key === current
              ? "-mb-px border-b-2 border-accent pb-2 font-medium"
              : "pb-2 text-muted hover:text-fg"
          }
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
