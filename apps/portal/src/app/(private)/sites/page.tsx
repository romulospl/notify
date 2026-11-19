import type { Metadata } from "next";
import Link from "next/link";
import { requireTenantContext } from "@/lib/access";
import { listSites } from "@/lib/data/sites";
import { SiteForm } from "./site-form";
import { cardClass } from "@/components/ui/card";

export const metadata: Metadata = { title: "Websites" };

// Sites web do tenant (#17). Cada site vira um site no Umami (#58); o nome leva
// ao painel do site (#28).
export default async function SitesPage() {
  const ctx = await requireTenantContext();
  const sites = await listSites(ctx);
  const canWrite = ctx.tenantStatus !== "removed";

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Websites</h1>
      <p className="mt-2 text-muted">
        Add each website you want to measure. Each website&apos;s page has its tracking script, ready to copy.
      </p>

      {canWrite ? (
        <div className="mt-6">
          <SiteForm />
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted">This project was removed; new websites can&apos;t be added.</p>
      )}

      <div className={`${cardClass} mt-8 overflow-x-auto px-4 py-1`}>
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-muted">
          <tr>
            <th className="py-2 font-medium">Name</th>
            <th className="py-2 font-medium">Domain</th>
            <th className="py-2 font-medium">Website ID</th>
            <th className="py-2 font-medium">
              <span className="sr-only">Tracking script</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sites.length === 0 && (
            <tr>
              <td colSpan={4} className="py-3 text-muted">
                No websites yet.
              </td>
            </tr>
          )}
          {sites.map((site) => (
            <tr key={site.id}>
              <td className="py-2">
                <Link href={`/sites/${site.id}`} className="font-medium hover:underline">
                  {site.name}
                </Link>
              </td>
              <td className="py-2">{site.domain}</td>
              <td className="py-2 font-mono text-xs">{site.umamiWebsiteId}</td>
              <td className="py-2 text-right">
                <Link href={`/sites/${site.id}#install`} className="font-medium text-accent-text hover:underline">
                  Get script
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}
