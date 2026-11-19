import type { Metadata } from "next";
import Link from "next/link";
import { requireOperatorContext } from "@/lib/access";
import { listTenants } from "@/lib/data/operator/tenants";
import { MetricCard } from "@/components/metrics/metric-card";
import { cardClass } from "@/components/ui/card";
import { Icon } from "@/components/ui/icons";
import { type ChipTone, StatusChip } from "@/components/ui/status-chip";

export const metadata: Metadata = { title: "SCF overview" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

const STATUSES = ["active", "pending", "removed"] as const;
type Status = (typeof STATUSES)[number];
const STATUS_LABEL: Record<Status, string> = { active: "Active", pending: "Pending", removed: "Removed" };
const STATUS_TONE: Record<Status, ChipTone> = { active: "good", pending: "warn", removed: "bad" };

function parseStatus(value: string | string[] | undefined): Status | null {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value) ? (value as Status) : null;
}

// Área do operador SCF (#19): todos os projetos, só leitura. Quem não é
// operador recebe 404. As rotas sob /operator são as únicas que aceitam um
// tenantId na URL. O painel comparativo web fica em /operator/web (#29); o de
// API entra no E6.
export default async function OperatorPage({
  searchParams,
}: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const ctx = await requireOperatorContext();
  const tenants = await listTenants(ctx);
  const active = tenants.filter((t) => t.status === "active").length;
  const pending = tenants.filter((t) => t.status === "pending").length;
  const filter = parseStatus((await searchParams)?.status);
  const shown = filter ? tenants.filter((t) => t.status === filter) : tenants;
  const activeTenants = tenants.filter((t) => t.status === "active");
  const sum = (key: "sites" | "services" | "activeKeys") => activeTenants.reduce((total, t) => total + t[key], 0);

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">SCF overview</h1>
      <p className="mt-2 text-muted">
        {tenants.length} project{tenants.length === 1 ? "" : "s"}, {active} active. Compare web metrics across
        projects in{" "}
        <Link href="/operator/web" className="underline">
          web analytics
        </Link>{" "}
        and{" "}
        <Link href="/operator/api" className="underline">
          API analytics
        </Link>
        .
      </p>
      {pending > 0 && (
        <p role="status" className="mt-4 flex items-start gap-2 rounded-control border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
          <Icon name="alert" className="mt-0.5 size-4" />
          <span>
            {pending} project{pending === 1 ? " is" : "s are"} waiting for{" "}
            <Link href="/operator/approvals" className="font-semibold underline">
              approval
            </Link>
            .
          </span>
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Active projects" value={String(active)} />
        <MetricCard label="Websites" value={String(sum("sites"))} />
        <MetricCard label="API services" value={String(sum("services"))} />
        <MetricCard label="Active ingest keys" value={String(sum("activeKeys"))} />
      </div>

      <nav aria-label="Filter by status" className="mt-8 flex flex-wrap gap-2 text-sm">
        {[null, ...STATUSES].map((status) => {
          const count = status ? tenants.filter((t) => t.status === status).length : tenants.length;
          const current = status === filter;
          return (
            <Link
              key={status ?? "all"}
              href={status ? `/operator?status=${status}` : "/operator"}
              aria-current={current ? "page" : undefined}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-medium ${
                current ? "border-op bg-op-soft text-op" : "border-border-strong text-muted hover:bg-surface-2 hover:text-fg"
              }`}
            >
              {status ? STATUS_LABEL[status] : "All"}
              <span className="tabular-nums">{count}</span>
            </Link>
          );
        })}
      </nav>

      <div className={`${cardClass} mt-4 overflow-x-auto px-4 py-1`}>
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 font-medium">Project</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 font-medium">Created</th>
              <th className="py-2 text-right font-medium">Members</th>
              <th className="py-2 text-right font-medium">Websites</th>
              <th className="py-2 text-right font-medium">API services</th>
              <th className="py-2 text-right font-medium">Active keys</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="py-3 text-muted">
                  {tenants.length === 0 ? "No projects yet." : "No projects with this status."}
                </td>
              </tr>
            )}
            {shown.map((t) => (
              <tr key={t.id}>
                <td className="py-2">
                  <Link href={`/operator/tenants/${t.id}`} className="font-medium hover:underline">
                    {t.name}
                  </Link>
                  <span className="ml-2 font-mono text-xs text-muted">{t.slug}</span>
                </td>
                <td className="py-2">
                  <StatusChip tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</StatusChip>
                </td>
                <td className="py-2">{dateFormat.format(t.createdAt)}</td>
                <td className="py-2 text-right">{t.members}</td>
                <td className="py-2 text-right">{t.sites}</td>
                <td className="py-2 text-right">{t.services}</td>
                <td className="py-2 text-right">{t.activeKeys}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
