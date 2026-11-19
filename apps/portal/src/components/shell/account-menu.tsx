"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "@/components/ui/icons";

export function AccountMenu({ email, signOut }: { email: string; signOut: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const element = details.current;
    if (!element) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && element.open) {
        element.open = false;
        element.querySelector("summary")?.focus();
      }
    };
    const onClick = (event: MouseEvent) => {
      if (element.open && !element.contains(event.target as Node)) element.open = false;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <details ref={details} className="relative">
      <summary
        aria-label="Account menu"
        className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-control px-2 hover:bg-surface-2 [&::-webkit-details-marker]:hidden"
      >
        <span aria-hidden="true" className="grid size-6.5 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent-text">
          {email.charAt(0).toUpperCase()}
        </span>
        <span className="hidden max-w-44 truncate text-muted sm:inline">{email}</span>
      </summary>
      <div className="absolute top-full right-0 z-40 mt-1 grid min-w-56 rounded-card border border-border bg-surface p-1 shadow-lg">
        <p className="mb-1 border-b border-border px-2.5 py-2 text-[0.8125rem] break-all text-muted">{email}</p>
        <Link href="/settings" className="flex min-h-9 items-center gap-2 rounded-control px-2.5 hover:bg-surface-2">
          <Icon name="gear" />
          Account settings
        </Link>
        {signOut}
      </div>
    </details>
  );
}
