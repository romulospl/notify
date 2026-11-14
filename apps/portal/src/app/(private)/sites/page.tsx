import type { Metadata } from "next";
import Link from "next/link";
import { requireTenantContext } from "@/lib/access";
import { listSites } from "@/lib/data/sites";
import { SiteForm } from "./site-form";

export const metadata: Metadata = { title: "Websites" };

// Sites web do tenant (#17). Cada site vira um site no Umami (#58); o nome leva
// ao painel do site (#28).
export default async function SitesPage() {
  const ctx = await requireTenantContext();
  const sites = await listSites(ctx);
  const canWrite = ctx.tenantStatus !== "removed";

  return (
    <section>
      <h1 className="text-2xl font-semibold">Websites</h1>
      <p className="mt-2 text-zinc-500">
        Add each website you want to measure. The tracking script uses the website ID shown below.
      </p>

      {canWrite ? (
        <div className="mt-6">
          <SiteForm />
        </div>
      ) : (
        <p className="mt-6 text-sm text-zinc-500">This project was removed; new websites can&apos;t be added.</p>
      )}

      <table className="mt-8 w-full text-left text-sm">
        <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
          <tr>
            <th className="py-2 font-medium">Name</th>
            <th className="py-2 font-medium">Domain</th>
            <th className="py-2 font-medium">Website ID</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {sites.length === 0 && (
            <tr>
              <td colSpan={3} className="py-3 text-zinc-500">
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
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
