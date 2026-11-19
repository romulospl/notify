"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { breadcrumbs } from "./nav-items";

export function Breadcrumbs() {
  const crumbs = breadcrumbs(usePathname());
  return (
    <nav aria-label="You are here" className="flex min-w-0 flex-1 items-center gap-1.5 text-[0.8125rem] text-muted">
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        if (last || !crumb.href) {
          return (
            <span key={crumb.label} aria-current={last ? "page" : undefined} className="truncate font-medium text-fg">
              {crumb.label}
            </span>
          );
        }
        return (
          <span key={crumb.label} className="hidden items-center gap-1.5 sm:flex">
            <Link href={crumb.href} className="hover:text-fg hover:underline">
              {crumb.label}
            </Link>
            <span aria-hidden="true">/</span>
          </span>
        );
      })}
    </nav>
  );
}
