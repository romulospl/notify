import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Icon } from "@/components/ui/icons";
import { NavLinks } from "./nav-links";
import type { ShellMode } from "./nav-items";

export function Sidebar({ mode }: { mode: ShellMode }) {
  const operator = mode === "operator";
  return (
    <div className="flex h-full flex-col gap-1 px-3 py-3.5">
      <Link href={operator ? "/operator" : "/dashboard"} className="flex items-center px-2 pt-1 pb-3 text-fg">
        <Logo className="h-8 w-auto" />
      </Link>
      <p
        className={`mx-1 mb-2 flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-xs font-semibold ${
          operator ? "bg-op-soft text-op" : "bg-accent-soft text-accent-text"
        }`}
      >
        <Icon name={operator ? "shield" : "layers"} />
        {operator ? "SCF operator view" : "Project view"}
      </p>
      <NavLinks mode={mode} />
      <div className="mt-auto grid gap-1 rounded-control border border-border p-3 text-xs text-muted">
        <p className="flex items-center gap-1.5 font-semibold text-fg">
          <Icon name={operator ? "eye" : "shield"} />
          {operator ? "Aggregated view" : "Privacy first"}
        </p>
        <p>
          {operator
            ? "Wallet addresses never appear. Projects see only their own data."
            : "No cookies. No personal data. Wallet addresses are never shown."}
        </p>
      </div>
    </div>
  );
}
