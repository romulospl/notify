import type { Metadata } from "next";
import Link from "next/link";
import { DocHeader, DocsLayout } from "@/components/site/docs-layout";
import { headingId } from "@/components/site/markdown";
import { DOCS_URL, REPO_URL } from "@/components/site/site-shell";
import { linkClass } from "@/components/ui/button";
import { DOC_SECTIONS } from "@/lib/docs";
import { env } from "@/lib/env";
import { TRACKER_VERSION, trackerSnippets } from "@/lib/tracker-snippet";

export const metadata: Metadata = { title: "Documentation" };
// The gateway and collector addresses shown here are read at run time.
export const dynamic = "force-dynamic";

const codeClass = "mt-4 overflow-x-auto rounded-control border border-border bg-surface-2 p-4 font-mono text-xs leading-relaxed text-fg";
const h2Class = "mt-14 scroll-mt-10 font-mono text-2xl font-normal tracking-tight text-fg";
const h3Class = "mt-8 font-mono text-lg font-normal text-fg";

// Public documentation index: a two-step quickstart built from the same
// values the portal shows to a signed-in tenant (the pinned script tag with
// its SRI hash, and the collector address), then links to the guides in the
// repository, rendered at /docs/[slug]. No data of any tenant is read here.
export default function DocsPage() {
  const tag = trackerSnippets("<your-site-id>").html;
  const otlp = [
    `# OTLP/HTTP, metric http.server.request.duration (or HTTP server spans)`,
    `POST ${env.collectorUrl}/v1/metrics`,
    `Authorization: Bearer ntf_<your-ingest-key>`,
  ].join("\n");
  const toc = [
    { depth: 2 as const, text: "Quickstart", id: "quickstart" },
    ...DOC_SECTIONS.map((section) => ({ depth: 2 as const, text: section.title, id: headingId(section.title) })),
  ];

  return (
    <DocsLayout toc={toc}>
      <DocHeader
        eyebrow="Getting started"
        title="Overview"
        lead={
          <p>
            How to measure a Stellar project with stellytics, what it does with the data, and how to run and operate
            it. The guides live in the{" "}
            <a href={REPO_URL} className={linkClass}>
              repository
            </a>{" "}
            and are rendered here from the same files.
          </p>
        }
      />

      <div className="text-[0.9375rem] text-fg/80">
        <section aria-labelledby="quickstart">
          <h2 id="quickstart" className={h2Class}>
            Quickstart
          </h2>
          <h3 className={h3Class}>1. Web: add the script</h3>
          <p className="mt-3 leading-7">
            Register the website in the portal and paste its tag before <code className="font-mono text-fg">&lt;/head&gt;</code>.
            The script is pinned to version {TRACKER_VERSION} and checked by the browser against the hash; it sets no
            cookie.
          </p>
          <pre className={codeClass}>{tag}</pre>
          <h3 className={h3Class}>2. API: export OpenTelemetry metrics</h3>
          <p className="mt-3 leading-7">
            Create an API service in the portal to get an ingest key, then add a second OTLP exporter next to the one
            you already use. Only route, method, status and duration are kept; traces and logs are dropped.
          </p>
          <pre className={codeClass}>{otlp}</pre>
          <p className="mt-5 leading-7">
            Full steps, custom events and troubleshooting are in the{" "}
            <Link href={`${DOCS_URL}/onboarding`} className={linkClass}>
              tenant onboarding guide
            </Link>
            .
          </p>
        </section>

        {DOC_SECTIONS.map((section) => (
          <section key={section.title} aria-labelledby={headingId(section.title)}>
            <h2 id={headingId(section.title)} className={h2Class}>
              {section.title}
            </h2>
            <p className="mt-3 leading-7">{section.text}</p>
            <ul className="docs-list">
              {section.links.map((link) => (
                <li key={link.slug}>
                  <Link href={`${DOCS_URL}/${link.slug}`} className="font-semibold text-accent-text hover:underline">
                    {link.label}
                  </Link>
                  <span className="text-muted">: {link.note}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </DocsLayout>
  );
}
