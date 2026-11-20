import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { linkClass, secondaryButtonClass } from "@/components/ui/button";

// Header and footer of the site pages (the home page and /docs). The demo
// has its own shell with the view tabs (components/demo/demo-shell.tsx).

export const REPO_URL = "https://github.com/romulospl/stellytics";
// Documentation index of the portal itself (src/app/docs/page.tsx).
export const DOCS_URL = "/docs";

const NAV = [
  { href: "/#features", label: "Features" },
  { href: `${REPO_URL}/blob/main/docs/architecture.md`, label: "How it works" },
  { href: REPO_URL, label: "Open Source" },
  { href: DOCS_URL, label: "Docs" },
];

export function GithubMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function SiteShell({ current, children }: { current?: string; children: ReactNode }) {
  const navLink = "rounded-control px-1 py-1 text-sm font-medium hover:text-fg";
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-content flex-col px-4 md:px-7">
      <header className="flex min-h-16 items-center gap-6 py-4">
        <Link href="/" className="text-fg">
          <Logo className="h-9 w-auto" />
        </Link>
        <nav aria-label="Main" className="mx-auto hidden items-center gap-10 md:flex">
          {NAV.map((item) => (
            <a
              key={item.label}
              href={item.href}
              aria-current={item.href === current ? "page" : undefined}
              className={`${navLink} ${item.href === current ? "text-accent-text" : "text-fg/85"}`}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4 md:ml-0">
          <ThemeToggle />
          <a href={REPO_URL} className={`${secondaryButtonClass} min-h-10 bg-transparent`}>
            <GithubMark className="size-5" />
            GitHub
          </a>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="mt-12 flex flex-wrap items-center gap-4 border-t border-border py-8 text-sm text-muted">
        <Logo className="h-8 w-auto text-fg" />
        <p className="ml-auto">
          Open source ·{" "}
          <a href={REPO_URL} className={linkClass}>
            Source code
          </a>{" "}
          ·{" "}
          <a href={DOCS_URL} className={linkClass}>
            Documentation
          </a>
        </p>
      </footer>
    </div>
  );
}
