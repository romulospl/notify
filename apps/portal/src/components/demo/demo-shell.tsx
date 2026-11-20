import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { SAMPLE_PROJECT } from "@/lib/demo-sample";
import { env } from "@/lib/env";
import { DemoTabs } from "./demo-tabs";

// Shell of the public demo pages: no session, no sidebar, no
// account menu. Logo and theme on the first row, the view tabs on the second.
// `narrow` is for the public card, which is a single column.
export function DemoShell({ narrow = false, children }: { narrow?: boolean; children: ReactNode }) {
  const width = narrow ? "max-w-2xl" : "max-w-content";
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto w-full max-w-content px-4 md:px-7">
          <div className="flex min-h-13 items-center gap-3">
            <Link href="/" className="text-fg">
              <Logo className="h-7 w-auto" />
            </Link>
            <span className="rounded-control bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-text">Demo</span>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </div>
          <DemoTabs cardHref={`/p/${env.demoTenantSlug || SAMPLE_PROJECT.slug}`} />
        </div>
      </header>
      <main className={`mx-auto w-full ${width} px-4 pt-5 pb-16 md:px-7 md:pt-7`}>{children}</main>
    </div>
  );
}
