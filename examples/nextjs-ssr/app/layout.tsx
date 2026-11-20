import { readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import type { ReactNode } from "react";

// The script tag is built on the server on every request (SSR), with the site
// and the gateway coming from the environment. On a real site, it is just the
// fixed HTML snippet from the README, with the site ID pasted in.
export const dynamic = "force-dynamic";

function tracker() {
  const website = process.env.STELLYTICS_WEBSITE_ID;
  if (!website) throw new Error("set STELLYTICS_WEBSITE_ID to the ID of the site in Umami");
  const gateway = (process.env.STELLYTICS_GATEWAY_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");
  const sri: Record<string, string> = JSON.parse(
    readFileSync(join(process.cwd(), "../../packages/tracker/published/sri.json"), "utf8"),
  );
  const version =
    process.env.STELLYTICS_SCRIPT_VERSION ??
    Object.keys(sri).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)!;
  return { src: `${gateway}/s/v${version}/n.js`, integrity: sri[version], website };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const t = tracker();
  return (
    <html lang="en">
      <head>
        <script defer src={t.src} integrity={t.integrity} crossOrigin="anonymous" data-site={t.website} />
      </head>
      <body>
        <nav>
          <Link href="/">Home</Link> <Link href="/docs">Documentation</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
