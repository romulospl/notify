import type { ReactNode } from "react";
import { AccountMenu } from "./account-menu";
import { Breadcrumbs } from "./breadcrumbs";
import { MobileDrawer } from "./mobile-drawer";
import type { ShellMode } from "./nav-items";
import { Sidebar } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";

type AppShellProps = {
  mode: ShellMode;
  email: string;
  signOut: ReactNode;
  children: ReactNode;
};

export function AppShell({ mode, email, signOut, children }: AppShellProps) {
  return (
    <div data-mode={mode} className="grid min-h-dvh grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <a
        href="#main-content"
        className="fixed top-2 -left-[999px] z-[200] rounded-control border border-border bg-surface px-3 py-2 focus:left-2"
      >
        Skip to content
      </a>
      <aside aria-label="Main navigation" className="sticky top-0 hidden h-dvh overflow-y-auto border-r border-border bg-surface lg:block">
        <Sidebar mode={mode} />
      </aside>
      <div className="flex min-w-0 flex-col">
        <header
          className={`sticky top-0 z-30 flex min-h-13 items-center gap-3 border-b border-border bg-bg/90 px-4 backdrop-blur ${
            mode === "operator" ? "shadow-[inset_0_3px_0_var(--op)]" : ""
          }`}
        >
          <MobileDrawer>
            <Sidebar mode={mode} />
          </MobileDrawer>
          <Breadcrumbs />
          <ThemeToggle />
          <AccountMenu email={email} signOut={signOut} />
        </header>
        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-content px-4 pt-5 pb-16 outline-none md:px-7 md:pt-7">
          {children}
        </main>
      </div>
    </div>
  );
}
