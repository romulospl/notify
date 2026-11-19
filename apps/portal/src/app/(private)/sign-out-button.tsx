"use client";

import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={async () => {
        await authClient.signOut();
        router.replace("/sign-in");
        router.refresh();
      }}
      className="flex min-h-9 w-full items-center gap-2 rounded-control px-2.5 text-left hover:bg-surface-2"
    >
      <Icon name="out" />
      Sign out
    </button>
  );
}
