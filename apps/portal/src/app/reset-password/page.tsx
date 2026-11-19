import type { Metadata } from "next";
import Link from "next/link";
import { AuthLayout } from "@/components/auth/auth-layout";
import { linkClass } from "@/components/ui/button";
import { ResetPasswordForm } from "./reset-password-form";

// O token está na URL: nenhuma página seguinte recebe o endereço como Referer.
export const metadata: Metadata = { title: "Choose a new password", referrer: "no-referrer" };

// Destino do link de redefinição (#60). O Better Auth confere o token antes
// de redirecionar: chega aqui com ?token= ou com ?error=INVALID_TOKEN.
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token, error } = await searchParams;

  if (error || typeof token !== "string" || token.length === 0) {
    return (
      <AuthLayout title="This link doesn't work">
        <p className="mt-4 text-sm text-muted">
          The reset link is invalid, was already used or expired. Ask for a new one.
        </p>
        <p className="mt-6 text-sm">
          <Link href="/forgot-password" className={linkClass}>
            Request a new link
          </Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password">
      <ResetPasswordForm token={token} />
    </AuthLayout>
  );
}
