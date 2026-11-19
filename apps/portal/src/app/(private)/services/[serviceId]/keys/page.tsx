import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenantContext } from "@/lib/access";
import { getApiService, listIngestKeys, MAX_ACTIVE_KEYS } from "@/lib/data/api-services";
import { CreateKeyButton, RevokeKeyButton } from "../../key-forms";
import { ServiceTabs } from "../service-tabs";
import { cardClass } from "@/components/ui/card";
import { StatusChip } from "@/components/ui/status-chip";

export const metadata: Metadata = { title: "Ingest keys" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

// Chaves de ingestão de um serviço (#59), na aba "Ingest keys". Serviço de outro tenant: 404.
export default async function ServicePage({ params }: { params: Promise<{ serviceId: string }> }) {
  const { serviceId } = await params;
  const ctx = await requireTenantContext();
  const service = await getApiService(ctx, serviceId);
  const keys = service ? await listIngestKeys(ctx, service.id) : null;
  if (!service || !keys) notFound();

  const active = keys.filter((k) => !k.revokedAt).length;
  const canCreate = ctx.tenantStatus !== "removed" && active < MAX_ACTIVE_KEYS;

  return (
    <section>
      <Link href="/services" className="text-sm text-muted hover:underline">
        ← API services
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{service.name}</h1>
      <ServiceTabs serviceId={service.id} current="keys" />
      <p className="mt-6 text-muted">
        {active} of {MAX_ACTIVE_KEYS} active keys. Create a new key before revoking the old one to rotate without
        losing data.
      </p>

      <div className="mt-6">
        <CreateKeyButton serviceId={service.id} disabled={!canCreate} />
      </div>

      <div className={`${cardClass} mt-8 overflow-x-auto px-4 py-1`}>
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-muted">
          <tr>
            <th className="py-2 font-medium">Key</th>
            <th className="py-2 font-medium">Created</th>
            <th className="py-2 font-medium">Last used</th>
            <th className="py-2 font-medium">Status</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {keys.map((key) => (
            <tr key={key.id}>
              <td className="py-2 font-mono">ntf_{key.prefix}_…</td>
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
                {!key.revokedAt && <RevokeKeyButton keyId={key.id} prefix={key.prefix} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}
