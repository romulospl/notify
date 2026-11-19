"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icons";
import { activeHref, NAV_GROUPS, type ShellMode } from "./nav-items";

export function NavLinks({ mode }: { mode: ShellMode }) {
  const current = activeHref(mode, usePathname());
  const activeClass = mode === "operator" ? "bg-op-soft text-op" : "bg-accent-soft text-accent-text";
  return (
    <nav aria-label="Sections" className="grid gap-0.5">
      {NAV_GROUPS[mode].map((group) => (
        <div key={group.label} className="grid gap-0.5">
          <p className="px-2.5 pt-3 pb-1 text-[0.6875rem] font-semibold tracking-wider text-muted uppercase">{group.label}</p>
          {group.items.map((item) => {
            const active = item.href === current;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-9 items-center gap-2.5 rounded-control px-2.5 font-medium ${
                  active ? activeClass : "text-muted hover:bg-surface-2 hover:text-fg"
                }`}
              >
                <Icon name={item.icon} />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
