import type { Metadata } from "next";
import Link from "next/link";
import { requireTenantContext } from "@/lib/access";
import { listApiServices } from "@/lib/data/api-services";
import { CreateServiceForm } from "./key-forms";
import { cardClass } from "@/components/ui/card";

export const metadata: Metadata = { title: "API services" };

// Serviços de API do tenant (#59). Cada serviço recebe a primeira chave de
// ingestão na criação.
export default async function ServicesPage() {
  const ctx = await requireTenantContext();
  const services = await listApiServices(ctx);
  const canWrite = ctx.tenantStatus !== "removed";

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">API services</h1>
      <p className="mt-2 text-muted">
        Each service sends OpenTelemetry metrics with its own ingest key.
      </p>

      {canWrite ? (
        <div className="mt-6">
          <CreateServiceForm />
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted">This project was removed; new services can&apos;t be added.</p>
      )}

      <ul className={`${cardClass} mt-8 divide-y divide-border py-1`}>
        {services.length === 0 && <li className="py-3 text-sm text-muted">No services yet.</li>}
        {services.map((service) => (
          <li key={service.id} className="py-3">
            <Link href={`/services/${service.id}`} className="font-medium hover:underline">
              {service.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
