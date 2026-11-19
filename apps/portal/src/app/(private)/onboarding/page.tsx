import type { Metadata } from "next";
import { requireOnboardingContext } from "@/lib/access";
import { ProjectForm } from "./project-form";

export const metadata: Metadata = { title: "Create your project" };

// Primeiro passo depois de confirmar o e-mail (#17). Quem já tem projeto é
// levado ao painel; operador recebe 404.
export default async function OnboardingPage() {
  await requireOnboardingContext();

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Create your project</h1>
      <p className="mt-2 max-w-xl text-muted">
        A project groups your websites and API services. Next you&apos;ll add them and get the tracking script and
        ingest keys.
      </p>
      <ProjectForm />
    </section>
  );
}
