"use server";

import { refresh } from "next/cache";
import { notFound } from "next/navigation";
import { requireOperatorContext } from "@/lib/access";
import {
  reactivateTenant,
  removeTenant,
  type StatusChangeResult,
  TenantStatusError,
} from "@/lib/data/operator/tenants";

// Remoção e reativação de projeto pelo operador SCF (#20). São endpoints
// públicos: quem não é operador recebe 404 em requireOperatorContext(), antes
// de qualquer leitura. O tenantId vem do cliente, o que só vale em /operator.

export type StatusActionState = { status: "idle" } | { status: "error"; message: string } | { status: "done" };

function finish(result: StatusChangeResult): StatusActionState {
  if (result === null) notFound();
  refresh();
  return { status: "done" };
}

function errorState(error: unknown): StatusActionState {
  if (error instanceof TenantStatusError) return { status: "error", message: error.message };
  throw error;
}

export async function removeTenantAction(
  tenantId: string,
  _prev: StatusActionState,
  form: FormData,
): Promise<StatusActionState> {
  const ctx = await requireOperatorContext();
  try {
    return finish(await removeTenant(ctx, tenantId, { reason: String(form.get("reason") ?? "") }));
  } catch (error) {
    return errorState(error);
  }
}

export async function reactivateTenantAction(
  tenantId: string,
  _prev: StatusActionState,
  form: FormData,
): Promise<StatusActionState> {
  const ctx = await requireOperatorContext();
  try {
    return finish(await reactivateTenant(ctx, tenantId, { reason: String(form.get("reason") ?? "") }));
  } catch (error) {
    return errorState(error);
  }
}
