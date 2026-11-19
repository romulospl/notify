"use client";

import { useActionState } from "react";
import { inputClass } from "@/components/ui/field";
import { approveTenantAction, rejectTenantAction, type StatusActionState } from "./actions";

const idle: StatusActionState = { status: "idle" };

// Aprovar ou rejeitar um cadastro pendente (#49). Só aparece na área do
// operador; as ações conferem de novo no servidor. O motivo da rejeição é
// obrigatório porque o projeto o vê no painel; o da aprovação é opcional.
export function ApprovalForm({ tenantId, reasonMax }: { tenantId: string; reasonMax: number }) {
  const [approveState, approve, approving] = useActionState(approveTenantAction.bind(null, tenantId), idle);
  const [rejectState, reject, rejecting] = useActionState(rejectTenantAction.bind(null, tenantId), idle);
  const busy = approving || rejecting;

  return (
    <div className="mt-3 grid max-w-3xl gap-6 text-sm sm:grid-cols-2">
      <form action={approve} className="space-y-3">
        <p className="text-muted">Approving lets the project add websites and services, and accepts ingestion.</p>
        <label className="block">
          <span className="font-medium">Note (optional)</span>
          <textarea name="reason" maxLength={reasonMax} rows={2} className={inputClass} />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-control bg-accent px-3 py-2 font-medium text-accent-fg hover:brightness-110 disabled:opacity-60"
        >
          {approving ? "Saving…" : "Approve"}
        </button>
        {approveState.status === "error" && (
          <p role="alert" className="text-bad">
            {approveState.message}
          </p>
        )}
      </form>
      <form action={reject} className="space-y-3">
        <p className="text-muted">Rejecting shows the reason to the project. It can be reactivated later.</p>
        <label className="block">
          <span className="font-medium">Reason (shown to the project)</span>
          <textarea name="reason" required minLength={3} maxLength={reasonMax} rows={2} className={inputClass} />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-control bg-bad px-3 py-2 font-medium text-white hover:brightness-110 disabled:opacity-60"
        >
          {rejecting ? "Saving…" : "Reject"}
        </button>
        {rejectState.status === "error" && (
          <p role="alert" className="text-bad">
            {rejectState.message}
          </p>
        )}
      </form>
    </div>
  );
}
