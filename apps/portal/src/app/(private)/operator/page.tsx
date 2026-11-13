import type { Metadata } from "next";
import { requireOperator } from "@/lib/session";

export const metadata: Metadata = { title: "SCF overview" };

// Área do operador SCF: visão global e comparativa (E4 e E6). Só para o papel operator.
export default async function OperatorPage() {
  await requireOperator();

  return (
    <section>
      <h1 className="text-2xl font-semibold">SCF overview</h1>
      <p className="mt-2 text-zinc-500">Cross-project web and API metrics will appear here.</p>
    </section>
  );
}
