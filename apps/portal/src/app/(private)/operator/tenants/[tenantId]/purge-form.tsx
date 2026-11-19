"use client";

import { useActionState } from "react";
import { inputClass } from "@/components/ui/field";
import { purgeTenantAction, type StatusActionState } from "./actions";

const idle: StatusActionState = { status: "idle" };

// Apagamento dos dados de um projeto removido (#154). É irreversível: sites
// saem do Umami, métricas de API e linhas do banco são apagadas. Por isso a
// confirmação é o slug digitado, não um botão.
export function PurgeForm({ tenantId, slug }: { tenantId: string; slug: string }) {
  const [state, purge, purging] = useActionState(purgeTenantAction.bind(null, tenantId), idle);

  return (
    <form action={purge} className="mt-3 max-w-3xl space-y-3 text-sm">
      <p className="text-muted">
        Erases everything the project collected: websites leave Umami, API metrics and rows are deleted. The project
        history in the audit trail stays, without its data. This cannot be undone.
      </p>
      <label className="block">
        <span className="font-medium">
          Type the project slug <span className="font-mono">{slug}</span> to confirm
        </span>
        <input name="confirm" required pattern={slug} className={inputClass} autoComplete="off" />
      </label>
      <button
        type="submit"
        disabled={purging}
        className="rounded-control bg-bad px-3 py-2 font-medium text-white hover:brightness-110 disabled:opacity-60"
      >
        {purging ? "Erasing…" : "Erase data"}
      </button>
      {state.status === "error" && (
        <p role="alert" className="text-bad">
          {state.message}
        </p>
      )}
    </form>
  );
}
