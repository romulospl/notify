import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { DocsSidebar } from "@/components/site/docs-sidebar";
import type { Heading } from "@/components/site/markdown";
import { OnThisPage } from "@/components/site/on-this-page";
import { DOCS_URL } from "@/components/site/site-shell";
import { DOC_SECTIONS, DOCS } from "@/lib/docs";

// Documentation layout (/docs and /docs/[slug]): a full-height column with
// search and the list of guides on the left, the page in the middle and, on
// wide screens, the headings of the page on the right.

const sidebar = DOC_SECTIONS.map((section) => ({
  title: section.title,
  links: section.links.map(({ slug, label, note }) => ({ slug, label, note })),
}));

// Eyebrow, title, lead and reading time at the top of every docs page.
export function DocHeader({
  eyebrow,
  title,
  lead,
  meta,
  aside,
}: {
  eyebrow: string;
  title: string;
  lead?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="border-b border-border pb-8">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted">
        <span>{eyebrow}</span>
        {aside}
      </div>
      <h1 className="mt-4 font-mono text-4xl font-normal tracking-tight break-words text-fg md:text-5xl">{title}</h1>
      {lead && <div className="mt-5 text-lg leading-relaxed text-muted [&>p:first-child]:mt-0">{lead}</div>}
      {meta && <p className="mt-5 font-mono text-[0.6875rem] text-muted">{meta}</p>}
    </header>
  );
}

// Previous and next guide in the order of src/lib/docs-index.json.
export function DocPager({ slug }: { slug: string }) {
  const i = DOCS.findIndex((doc) => doc.slug === slug);
  const prev = DOCS[i - 1];
  const next = DOCS[i + 1];
  const card = "group rounded-control border border-border p-4 hover:border-accent";
  return (
    <nav aria-label="Previous and next guide" className="mt-16 grid gap-3 border-t border-border pt-8 sm:grid-cols-2">
      {prev && (
        <Link href={`${DOCS_URL}/${prev.slug}`} className={card}>
          <span className="font-mono text-xs text-muted">← Previous</span>
          <span className="mt-1 block text-fg group-hover:text-accent-text">{prev.label}</span>
        </Link>
      )}
      {next && (
        <Link href={`${DOCS_URL}/${next.slug}`} className={`${card} sm:col-start-2 sm:text-right`}>
          <span className="font-mono text-xs text-muted">Next →</span>
          <span className="mt-1 block text-fg group-hover:text-accent-text">{next.label}</span>
        </Link>
      )}
    </nav>
  );
}

export function DocsLayout({ current, toc = [], children }: { current?: string; toc?: Heading[]; children: ReactNode }) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="flex flex-col border-b border-border px-4 pt-5 pb-4 lg:sticky lg:top-0 lg:h-dvh lg:border-r lg:border-b-0 lg:px-6 lg:pt-6 lg:pb-0">
        <div className="mb-5 flex items-center justify-between gap-3">
          <Link href="/" className="text-fg" aria-label="stellytics home">
            <Logo className="h-8 w-auto" />
          </Link>
          <ThemeToggle />
        </div>
        <DocsSidebar sections={sidebar} current={current} base={DOCS_URL} />
      </aside>

      <div className="flex min-w-0 justify-center gap-14 px-4 py-10 md:px-10 md:py-12">
        <main className="w-full max-w-3xl min-w-0">{children}</main>
        {toc.length > 1 && (
          <aside className="hidden w-56 shrink-0 xl:block">
            <OnThisPage items={toc} />
          </aside>
        )}
      </div>
    </div>
  );
}
