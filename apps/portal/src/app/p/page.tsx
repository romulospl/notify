import { redirect } from "next/navigation";
import { SAMPLE_PROJECT } from "@/lib/demo-sample";
import { env } from "@/lib/env";

// DEMO_TENANT_SLUG is read at run time.
export const dynamic = "force-dynamic";

// /p alone has no card of its own: it sends to the demo project's card, the
// only public one, with the same slug as the demo tabs (demo-shell.tsx).
export default function PublicCardIndexPage() {
  redirect(`/p/${env.demoTenantSlug || SAMPLE_PROJECT.slug}`);
}
