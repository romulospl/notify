import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireTenantContext } from "@/lib/access";
import { listApiServices } from "@/lib/data/api-services";
import { listSites } from "@/lib/data/sites";
import { getProject } from "@/lib/data/tenants";
import { requireSession } from "@/lib/session";
import { cardClass } from "@/components/ui/card";
import { Icon } from "@/components/ui/icons";

export const metadata: Metadata = { title: "Project" };

// Área do tenant, com links para os painéis web (E4) e de API (E6). As rotas do
// tenant não levam o ID do tenant na URL: ele vem da sessão (spec do E2, seção 4).
export default async function DashboardPage() {
  const { user } = await requireSession();
  // /dashboard é o destino padrão depois do login; o operador não tem projeto (D2).
  if (user.role === "operator") redirect("/operator");

  // Sem projeto, vai para a criação do projeto (#17).
  const ctx = await requireTenantContext({ allowPending: true });
  const project = await getProject(ctx);

  // Cadastro com aprovação (#49): espera, sem painéis nem cadastro.
  if (project.status === "pending") {
    return (
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        <p className="mt-2 text-muted">
          Your project is awaiting approval by the SCF operators. Websites, API services and ingest keys become
          available once it is approved; sign in again later to check.
        </p>
      </section>
    );
  }

  if (project.status === "removed") {
    return (
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        <p className="mt-2 text-muted">This project was removed by the SCF operators.</p>
        {project.statusReason && <p className="mt-2 text-sm text-muted">Reason: {project.statusReason}</p>}
      </section>
    );
  }

  const [sites, services] = await Promise.all([listSites(ctx), listApiServices(ctx)]);

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
      <p className="mt-2 text-muted">Open a website or an API service to see its analytics.</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Link
          href="/sites"
          className={`${cardClass} flex items-start gap-3 hover:border-accent`}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-control bg-accent-soft text-accent-text">
            <Icon name="globe" />
          </span>
          <div>
            <p className="font-semibold">Websites</p>
            <p className="mt-1 text-sm text-muted">
              {sites.length === 0 ? "Add your first website." : `${sites.length} registered`}
            </p>
          </div>
        </Link>
        <Link
          href="/services"
          className={`${cardClass} flex items-start gap-3 hover:border-accent`}
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-control bg-accent-soft text-accent-text">
            <Icon name="server" />
          </span>
          <div>
            <p className="font-semibold">API services</p>
            <p className="mt-1 text-sm text-muted">
              {services.length === 0 ? "Add a service to get an ingest key." : `${services.length} registered`}
            </p>
          </div>
        </Link>
      </div>

      {sites.length > 0 && (
        <>
          <h2 className="mt-8 text-lg font-semibold">Web analytics</h2>
          <ul className={`${cardClass} mt-2 divide-y divide-border py-1`}>
            {sites.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                <Link href={`/sites/${s.id}`} className="font-medium hover:underline">
                  {s.name}
                </Link>
                <span className="text-muted">{s.domain}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {services.length > 0 && (
        <>
          <h2 className="mt-8 text-lg font-semibold">API analytics</h2>
          <ul className={`${cardClass} mt-2 divide-y divide-border py-1`}>
            {services.map((s) => (
              <li key={s.id} className="py-2 text-sm">
                <Link href={`/services/${s.id}`} className="font-medium hover:underline">
                  {s.name}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
