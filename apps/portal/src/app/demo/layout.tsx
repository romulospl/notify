import type { Metadata } from "next";
import { DemoShell } from "@/components/demo/demo-shell";

// The public card link in the tabs depends on DEMO_TENANT_SLUG, read at run time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: { default: "Public demo", template: "%s · stellytics demo" } };

// The pages under it are read-only and show sample data or a single tenant (docs/dev/portal.md).
export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return <DemoShell>{children}</DemoShell>;
}
