import type { Metadata } from "next";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Project" };

// Área do tenant. Os painéis web (E4) e de API (E6) entram aqui.
export default async function DashboardPage() {
  const { user } = await requireSession();

  return (
    <section>
      <h1 className="text-2xl font-semibold">Project</h1>
      <p className="mt-2 text-zinc-500">Signed in as {user.name}. Your web and API analytics will appear here.</p>
    </section>
  );
}
