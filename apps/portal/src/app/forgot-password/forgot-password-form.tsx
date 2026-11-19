"use client";

import { useState } from "react";
import { buttonClass } from "@/components/ui/button";
import { errorClass, inputClass } from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";

// Pedido de redefinição de senha (#60). A resposta é a mesma com ou sem conta
// para o e-mail, para não revelar quem está cadastrado.
export function ForgotPasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error } = await authClient.requestPasswordReset({
      email: String(form.get("email")),
      redirectTo: "/reset-password",
    });
    setPending(false);
    if (error) {
      setError(error.status === 429 ? "Too many attempts. Try again later." : "Something went wrong. Try again.");
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <p role="status" className="mt-6 text-sm">
        If an account exists for this email, we sent a link to reset the password. It expires in 30 minutes.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Email</span>
        <input name="email" type="email" required autoComplete="email" className={inputClass} />
      </label>
      {error && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
