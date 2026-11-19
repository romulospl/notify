"use server";

import { refresh } from "next/cache";
import { requireTenantContext } from "@/lib/access";
import { createSite, SiteInputError } from "@/lib/data/sites";

export type SiteActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "created"; siteId: string };

// Cadastra um site do tenant da sessão (#17): cria no Umami e grava o vínculo (#58).
export async function createSiteAction(_prev: SiteActionState, form: FormData): Promise<SiteActionState> {
  const ctx = await requireTenantContext();
  let siteId: string;
  try {
    const created = await createSite(ctx, {
      name: String(form.get("name") ?? ""),
      domain: String(form.get("domain") ?? ""),
    });
    siteId = created.id;
  } catch (error) {
    if (error instanceof SiteInputError) return { status: "error", message: error.message };
    // Umami fora do ar ou chave inválida: o detalhe fica só no log.
    console.error("Falha ao cadastrar site", (error as Error).name, (error as Error).message);
    return { status: "error", message: "Web analytics is unavailable right now. Try again in a few minutes." };
  }
  refresh();
  // The form then opens the site's page, where the tracking script is.
  return { status: "created", siteId };
}
