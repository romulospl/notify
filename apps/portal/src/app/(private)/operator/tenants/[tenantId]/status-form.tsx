"use client";

import { useActionState } from "react";
import { inputClass } from "@/components/auth-card";
import { reactivateTenantAction, removeTenantAction, type StatusActionState } from "./actions";

const idle: StatusActionState = { status: "idle" };

// Remover ou reativar o projeto (#20). Só aparece na área do operador; a ação
// confere de novo no servidor.
export function TenantStatusForm({
  tenantId,
  status,
  reasonMax,
}: {
  tenantId: string;
  status: "active" | "removed" | "pending";
  reasonMax: number;
}) {
  const removing = status !== "removed";
  const [state, action, pending] = useActionState(
    (removing ? removeTenantAction : reactivateTenantAction).bind(null, tenantId),
    idle,
  );

  return (
    <form action={action} className="mt-3 max-w-xl space-y-3 text-sm">
      <p className="text-zinc-500">
        {removing
          ? "Removing stops web and API ingestion within a minute and hides the project's dashboards from its members. Collected data is kept, and the project can be reactivated."
          : "Reactivating accepts ingestion again within a minute and restores the project's dashboards."}
      </p>
      <label className="block">
        <span className="font-medium">{removing ? "Reason (shown to the project)" : "Note (optional)"}</span>
        <textarea
          name="reason"
          required={removing}
          minLength={removing ? 3 : undefined}
          maxLength={reasonMax}
          rows={2}
          className={inputClass}
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className={
          removing
            ? "rounded-md bg-red-700 px-3 py-2 font-medium text-white hover:bg-red-600 disabled:opacity-60"
            : "rounded-md bg-zinc-900 px-3 py-2 font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        }
      >
        {pending ? "Saving…" : removing ? "Remove project" : "Reactivate project"}
      </button>
      {state.status === "error" && (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {state.message}
        </p>
      )}
    </form>
  );
}
