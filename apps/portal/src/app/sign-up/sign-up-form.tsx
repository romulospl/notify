"use client";

import { useState } from "react";
import { buttonClass } from "@/components/ui/button";
import { errorClass, hintClass, inputClass } from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";

// Cadastro (#60). A conta só entra depois de confirmar o e-mail. A resposta é
// a mesma quando o e-mail já tem conta, para não revelar quem está cadastrado.
export function SignUpForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) {
      setError("The passwords don't match.");
      return;
    }
    setPending(true);
    const email = String(form.get("email"));
    const { error } = await authClient.signUp.email({
      name: String(form.get("name")),
      email,
      password,
      callbackURL: "/email-verified",
    });
    setPending(false);
    if (error) {
      if (error.status === 429) setError("Too many attempts. Try again later.");
      else if (error.code === "PASSWORD_TOO_SHORT") setError("Use at least 12 characters.");
      else setError("Could not create the account. Check the fields and try again.");
      return;
    }
    setSentTo(email);
  }

  if (sentTo) {
    return (
      <p role="status" className="mt-6 text-sm">
        We sent a confirmation link to <strong>{sentTo}</strong>. Open it to finish creating your account. The
        link expires in 24 hours.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Your name</span>
        <input name="name" required maxLength={100} autoComplete="name" className={inputClass} />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Email</span>
        <input name="email" type="email" required autoComplete="email" className={inputClass} />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Password</span>
        <input
          name="password"
          type="password"
          required
          minLength={12}
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
          autoComplete="new-password"
          className={inputClass}
        />
      </label>
      {error && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
