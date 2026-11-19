import type { Metadata } from "next";
import Link from "next/link";
import { requireOperatorContext } from "@/lib/access";
import { listReadKeys, MAX_ACTIVE_READ_KEYS } from "@/lib/data/operator/api-keys";
import { READ_API_LIMIT } from "@/lib/rate-limit";
import { CreateReadKeyForm, RevokeReadKeyButton } from "./read-key-forms";
import { cardClass } from "@/components/ui/card";
import { StatusChip } from "@/components/ui/status-chip";

export const metadata: Metadata = { title: "Read API keys" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

// Chaves de API do SCF para ler as métricas (#48, ADR 0006). Quem não é
// operador recebe 404.
export default async function OperatorKeysPage() {
  const ctx = await requireOperatorContext();
  const keys = await listReadKeys(ctx);
  const active = keys.filter((k) => !k.revokedAt).length;

  return (
    <section>
      <Link href="/operator" className="text-sm text-muted hover:underline">
        ← SCF overview
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Read API keys</h1>
      <p className="mt-2 text-muted">
        Keys give read-only access to the metrics of all active projects through <code>/api/v1/projects</code>,{" "}
        <code>/api/v1/web</code> and <code>/api/v1/api</code> (query <code>period</code>: 24h, 7d, 30d, 90d or 12m).
        Each key is limited to {READ_API_LIMIT} requests per minute. Every SCF operator sees and can revoke every key.
        A key stops working when the operator who created it loses the role. {active} of {MAX_ACTIVE_READ_KEYS} active
        keys.
      </p>

      <div className="mt-6">
        <CreateReadKeyForm disabled={active >= MAX_ACTIVE_READ_KEYS} />
      </div>

      <div className={`${cardClass} mt-8 overflow-x-auto px-4 py-1`}>
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-muted">
          <tr>
            <th className="py-2 font-medium">Name</th>
            <th className="py-2 font-medium">Key</th>
            <th className="py-2 font-medium">Created</th>
            <th className="py-2 font-medium">Last used</th>
            <th className="py-2 font-medium">Status</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {keys.length === 0 && (
            <tr>
              <td colSpan={6} className="py-3 text-muted">
                No keys yet.
              </td>
            </tr>
          )}
          {keys.map((key) => (
            <tr key={key.id}>
              <td className="py-2">
                {key.name}
                {key.createdByMe && <span className="ml-2 text-xs text-muted">(yours)</span>}
              </td>
              <td className="py-2 font-mono">nrk_{key.prefix}_…</td>
              <td className="py-2">{dateFormat.format(key.createdAt)}</td>
              <td className="py-2">{key.lastUsedOn ?? "Never"}</td>
              <td className="py-2">
                {key.revokedAt ? (
                  <StatusChip tone="neutral">{`Revoked ${dateFormat.format(key.revokedAt)}`}</StatusChip>
                ) : (
                  <StatusChip tone="good">Active</StatusChip>
                )}
              </td>
              <td className="py-2 text-right">
                {!key.revokedAt && <RevokeReadKeyButton keyId={key.id} name={key.name} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}
