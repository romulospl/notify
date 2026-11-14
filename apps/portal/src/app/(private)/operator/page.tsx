import type { Metadata } from "next";
import Link from "next/link";
import { requireOperatorContext } from "@/lib/access";
import { listTenants } from "@/lib/data/operator/tenants";

export const metadata: Metadata = { title: "SCF overview" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

// Área do operador SCF (#19): todos os projetos, só leitura. Quem não é
// operador recebe 404. As rotas sob /operator são as únicas que aceitam um
// tenantId na URL. O painel comparativo web fica em /operator/web (#29); o de
// API entra no E6.
export default async function OperatorPage() {
  const ctx = await requireOperatorContext();
  const tenants = await listTenants(ctx);
  const active = tenants.filter((t) => t.status === "active").length;

  return (
    <section>
      <h1 className="text-2xl font-semibold">SCF overview</h1>
      <p className="mt-2 text-zinc-500">
        {tenants.length} project{tenants.length === 1 ? "" : "s"}, {active} active. Compare web metrics across
        projects in{" "}
        <Link href="/operator/web" className="underline">
          web analytics
        </Link>
        ; API metrics will appear here.
      </p>

      <div className="mt-8 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
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
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {tenants.length === 0 && (
              <tr>
                <td colSpan={7} className="py-3 text-zinc-500">
                  No projects yet.
                </td>
              </tr>
            )}
            {tenants.map((t) => (
              <tr key={t.id}>
                <td className="py-2">
                  <Link href={`/operator/tenants/${t.id}`} className="font-medium hover:underline">
                    {t.name}
                  </Link>
                  <span className="ml-2 font-mono text-xs text-zinc-500">{t.slug}</span>
                </td>
                <td className="py-2 capitalize">{t.status}</td>
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
