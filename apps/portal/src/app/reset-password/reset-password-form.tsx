"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClass, linkClass } from "@/components/ui/button";
import { errorClass, hintClass, inputClass } from "@/components/ui/field";
import { authClient } from "@/lib/auth-client";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("password"));
    if (newPassword !== String(form.get("confirm"))) {
      setError("The passwords don't match.");
      return;
    }
    setPending(true);
    const { error } = await authClient.resetPassword({ newPassword, token });
    setPending(false);
    if (error) {
      if (error.code === "INVALID_TOKEN") setExpired(true);
      else if (error.code === "PASSWORD_TOO_SHORT") setError("Use at least 12 characters.");
      else if (error.status === 429) setError("Too many attempts. Try again later.");
      else setError("Could not change the password. Try again.");
      return;
    }
    // Redefinir encerra as sessões; a pessoa entra de novo com a senha nova.
    router.replace("/sign-in?reset=1");
  }

  if (expired) {
    return (
      <p role="alert" className="mt-4 text-sm">
        The reset link expired or was already used.{" "}
        <Link href="/forgot-password" className={linkClass}>
          Request a new link
        </Link>
        .
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <label className="block">
        <span className="text-sm font-medium">New password</span>
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
        <span className="text-sm font-medium">Confirm new password</span>
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
        {pending ? "Saving…" : "Save new password"}
      </button>
    </form>
  );
}
