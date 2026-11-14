import Link from "next/link";
import { requireSession } from "@/lib/session";
import { SignOutButton } from "./sign-out-button";

export default async function PrivateLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireSession();
  const isOperator = user.role === "operator";

  return (
    <div className="min-h-dvh">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold">notify</span>
          <nav className="flex gap-4 text-sm">
            {/* D2: o operador não é membro de tenant, então não tem "Project". */}
            {isOperator ? (
              <>
                <Link href="/operator" className="hover:underline">
                  SCF overview
                </Link>
                <Link href="/operator/web" className="hover:underline">
                  Web analytics
                </Link>
              </>
            ) : (
              <>
                <Link href="/dashboard" className="hover:underline">
                  Project
                </Link>
                <Link href="/sites" className="hover:underline">
                  Websites
                </Link>
                <Link href="/services" className="hover:underline">
                  API services
                </Link>
              </>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-zinc-500">{user.email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
