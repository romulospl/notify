"use client";

import { useActionState } from "react";
import { inputClass } from "@/components/ui/field";
import { deleteAccountAction, type AccountActionState } from "./actions";

const idle: AccountActionState = { status: "idle" };

// Confirmação da exclusão da conta (#154): o e-mail digitado, não um botão.
export function DeleteAccountForm({ email }: { email: string }) {
  const [state, submit, submitting] = useActionState(deleteAccountAction, idle);

  return (
    <form action={submit} className="mt-3 max-w-3xl space-y-3 text-sm">
      <p className="text-muted">
        This deletes your account, your project and everything it collected: websites leave Umami, API metrics and rows
        are removed. Your actions recorded in the audit trail stay, anonymized. This cannot be undone.
      </p>
      <label className="block">
        <span className="font-medium">
          Type your account email <span className="font-mono">{email}</span> to confirm
        </span>
        <input name="confirm" required className={inputClass} autoComplete="off" />
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="rounded-control bg-bad px-3 py-2 font-medium text-white hover:brightness-110 disabled:opacity-60"
      >
        {submitting ? "Deleting…" : "Delete account"}
      </button>
      {state.status === "error" && (
        <p role="alert" className="text-bad">
          {state.message}
        </p>
      )}
    </form>
  );
}
