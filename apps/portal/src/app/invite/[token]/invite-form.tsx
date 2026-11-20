"use client";

import { useActionState } from "react";
import { buttonClass } from "@/components/ui/button";
import { errorClass, hintClass, inputClass } from "@/components/ui/field";
import { acceptInviteAction, type InviteActionState } from "./actions";

const initial: InviteActionState = { error: null };

export function InviteForm({ token, email }: { token: string; email: string }) {
  const [state, action, pending] = useActionState(acceptInviteAction.bind(null, token), initial);

  if (state.gone) {
    return (
      <p role="alert" className="mt-4 text-sm">
        This invite expired or was already used. Ask the person who invited you for a new one.
      </p>
    );
  }

  return (
    <form action={action} className="mt-6 space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Email</span>
        <input value={email} readOnly autoComplete="username" className={inputClass} />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Name</span>
        <input name="name" required maxLength={100} autoComplete="name" className={inputClass} />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Password</span>
        <input
          name="password"
          type="password"
          required
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
          className={inputClass}
        />
        <span className={hintClass}>At least 12 characters.</span>
      </label>
      <label className="block">
        <span className="text-sm font-medium">Confirm password</span>
        <input
          name="confirm"
          type="password"
          required
          minLength={12}
          maxLength={128}
          autoComplete="new-password"
          className={inputClass}
        />
      </label>
      {state.error && (
        <p role="alert" className={errorClass}>
          {state.error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Creating…" : "Create operator account"}
      </button>
    </form>
  );
}
