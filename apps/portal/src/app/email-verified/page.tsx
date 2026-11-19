import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthLayout } from "@/components/auth/auth-layout";
import { linkClass } from "@/components/ui/button";
import { auth } from "@/lib/auth";

export const metadata: Metadata = { title: "Email confirmation" };

// Destino do link de confirmação (#60). Com o link válido, o Better Auth já
// abriu a sessão e a pessoa segue para o projeto. Com o link vencido ou
// inválido, chega aqui com ?error=.
export default async function EmailVerifiedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { error } = await searchParams;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!error && session) redirect("/dashboard");

  const expired = error === "TOKEN_EXPIRED";
  return (
    <AuthLayout title={error ? "This link doesn't work" : "Email confirmed"}>
      <p className="mt-4 text-sm text-muted">
        {error
          ? expired
            ? "The confirmation link expired. Sign in with your email and password and we'll send a new one."
            : "The confirmation link is invalid. Sign in with your email and password and we'll send a new one."
          : "Your email is confirmed. Sign in to continue."}
      </p>
      <p className="mt-6 text-sm">
        <Link href="/sign-in" className={linkClass}>
          Go to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
