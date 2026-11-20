import type { Metadata } from "next";
import { AuthLayout } from "@/components/auth/auth-layout";
import { loadOperatorInvite } from "@/lib/access";
import { InviteForm } from "./invite-form";

// The token is in the URL: no following page gets the address as Referer.
export const metadata: Metadata = { title: "Accept operator invite", referrer: "no-referrer" };

// Target of the operator invite link (ADR 0017). Public: the token is the
// credential. Any problem with the link shows the same message.
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await loadOperatorInvite(token);

  if (!invite) {
    return (
      <AuthLayout title="This invite doesn't work">
        <p className="mt-4 text-sm text-muted">
          The invite link is invalid, was already used or expired. Ask the person who invited you for a new one.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Become an SCF operator"
      subtitle="Operators see every project on stellytics. Choose your name and password to finish."
    >
      <InviteForm token={token} email={invite.email} />
      <p className="mt-4 text-xs text-muted">
        This invite expires on {invite.expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC.
      </p>
    </AuthLayout>
  );
}
