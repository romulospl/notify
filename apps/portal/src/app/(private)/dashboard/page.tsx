import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireTenantContext } from "@/lib/access";
import { listApiServices } from "@/lib/data/api-services";
import { listSites } from "@/lib/data/sites";
import { getProject } from "@/lib/data/tenants";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Project" };

// Área do tenant. Os painéis web (E4) e de API (E6) entram aqui. As rotas do
// tenant não levam o ID do tenant na URL: ele vem da sessão (spec do E2, seção 4).
export default async function DashboardPage() {
  const { user } = await requireSession();
  // /dashboard é o destino padrão depois do login; o operador não tem projeto (D2).
  if (user.role === "operator") redirect("/operator");

  // Sem projeto, vai para a criação do projeto (#17).
  const ctx = await requireTenantContext();
  const project = await getProject(ctx);

  if (project.status === "removed") {
    return (
      <section>
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        <p className="mt-2 text-zinc-500">This project was removed by the SCF operators.</p>
        {project.statusReason && <p className="mt-2 text-sm text-zinc-500">Reason: {project.statusReason}</p>}
      </section>
    );
  }

  const [sites, services] = await Promise.all([listSites(ctx), listApiServices(ctx)]);

  return (
    <section>
      <h1 className="text-2xl font-semibold">{project.name}</h1>
      <p className="mt-2 text-zinc-500">Open a website to see its analytics. API analytics will appear here.</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Link
          href="/sites"
          className="rounded-lg border border-zinc-200 p-4 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
        >
          <p className="font-medium">Websites</p>
          <p className="mt-1 text-sm text-zinc-500">
            {sites.length === 0 ? "Add your first website." : `${sites.length} registered`}
          </p>
        </Link>
        <Link
          href="/services"
          className="rounded-lg border border-zinc-200 p-4 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
        >
          <p className="font-medium">API services</p>
          <p className="mt-1 text-sm text-zinc-500">
            {services.length === 0 ? "Add a service to get an ingest key." : `${services.length} registered`}
          </p>
        </Link>
      </div>

      {sites.length > 0 && (
        <>
          <h2 className="mt-8 text-lg font-semibold">Web analytics</h2>
          <ul className="mt-2 divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {sites.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                <Link href={`/sites/${s.id}`} className="font-medium hover:underline">
                  {s.name}
                </Link>
                <span className="text-zinc-500">{s.domain}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
