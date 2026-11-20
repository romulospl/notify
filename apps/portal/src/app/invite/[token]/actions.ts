"use server";

import { redirect } from "next/navigation";
import { loadOperatorInvite } from "@/lib/access";
import { acceptOperatorInvite, OperatorInviteError } from "@/lib/data/operator-invite";

export type InviteActionState = { error: string | null; gone?: boolean };

// Accepts an operator invite (ADR 0017). The token is bound by the page; the
// form only sends the name and the password.
export async function acceptInviteAction(
  token: string,
  _prev: InviteActionState,
  form: FormData,
): Promise<InviteActionState> {
  const ctx = await loadOperatorInvite(token);
  if (!ctx) return { error: null, gone: true };
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) return { error: "The passwords don't match." };
  try {
    await acceptOperatorInvite(ctx, { name: String(form.get("name") ?? ""), password });
  } catch (error) {
    if (error instanceof OperatorInviteError) {
      if (error.code === "invite_gone") return { error: null, gone: true };
      return { error: error.message };
    }
    console.error("Failed to accept operator invite", (error as Error).name);
    return { error: "Something went wrong. Try again." };
  }
  redirect("/sign-in?invited=1");
}
