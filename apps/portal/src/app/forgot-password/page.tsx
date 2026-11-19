import type { Metadata } from "next";
import Link from "next/link";
import { AuthLayout } from "@/components/auth/auth-layout";
import { linkClass } from "@/components/ui/button";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <AuthLayout title="Reset your password" subtitle="We'll email you a link to choose a new password.">
      <ForgotPasswordForm />
      <p className="mt-6 text-sm text-muted">
        <Link href="/sign-in" className={linkClass}>
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
