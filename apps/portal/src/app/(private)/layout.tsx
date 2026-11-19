import { AppShell } from "@/components/shell/app-shell";
import { requireSession } from "@/lib/session";
import { SignOutButton } from "./sign-out-button";

export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSession();
  const mode = user.role === "operator" ? "operator" : "project";

  return (
    <AppShell mode={mode} email={user.email} signOut={<SignOutButton />}>
      {children}
    </AppShell>
  );
}
