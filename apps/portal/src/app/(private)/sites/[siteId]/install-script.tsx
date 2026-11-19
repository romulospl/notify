"use client";

import { useState } from "react";
import type { TrackerSnippets } from "@/lib/tracker-snippet";

const tabs = [
  { key: "html", label: "HTML / SPA" },
  { key: "nextjs", label: "Next.js" },
] as const;

type Tab = (typeof tabs)[number]["key"];

// Tag ready to copy, with where to paste it for each kind of site.
export function InstallScript({ snippets, domain }: { snippets: TrackerSnippets; domain: string }) {
  const [tab, setTab] = useState<Tab>("html");
  const [copied, setCopied] = useState<Tab | null>(null);
  const code = snippets[tab];

  return (
    <div className="mt-3 text-sm">
      <div role="tablist" aria-label="Kind of site" className="inline-flex gap-0.5 rounded-control border border-border bg-surface p-0.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-[0.375rem] px-3 py-1 font-medium ${
              tab === t.key
                ? "bg-accent text-accent-fg"
                : "text-muted hover:bg-surface-2 hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="mt-3">
        {tab === "html" ? (
          <p className="text-muted">
            Paste it in the <code>&lt;head&gt;</code> of every page of {domain}. In a single-page app (React, Vue,
            Svelte), <code>index.html</code> is enough: route changes are counted automatically.
          </p>
        ) : (
          <p className="text-muted">
            Paste it in <code>app/layout.tsx</code>, inside <code>&lt;head&gt;</code>. Don&apos;t use{" "}
            <code>next/script</code> with <code>strategy=&quot;lazyOnload&quot;</code>: it loads too late and may miss
            the first page view.
          </p>
        )}
        <div className="relative mt-2">
          <pre className="overflow-x-auto rounded-control border border-border bg-surface-2 p-3 pr-20 font-mono text-xs">
            <code>{code}</code>
          </pre>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(code);
              setCopied(tab);
            }}
            className="absolute top-2 right-2 rounded-control border border-border-strong bg-surface px-3 py-1 font-medium hover:bg-surface-2"
          >
            {copied === tab ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <ul className="mt-3 list-disc space-y-1 pl-5 text-muted">
        <li>Your site must be served over HTTPS (or from localhost); otherwise visits aren&apos;t sent.</li>
        <li>An ad blocker in your own browser may hide your visits while you test.</li>
        <li>After installing, open your site and reload this page to see the visit.</li>
      </ul>
    </div>
  );
}
