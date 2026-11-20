import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocHeader, DocPager, DocsLayout } from "@/components/site/docs-layout";
import { headings, Markdown, readingMinutes, splitGuide } from "@/components/site/markdown";
import { linkClass } from "@/components/ui/button";
import { DOC_SECTIONS, DOCS, findDoc, readDoc, REPO_BLOB_URL, resolveDocLink } from "@/lib/docs";

// One guide of the repository, rendered from its Markdown file with
// react-markdown. Built once per listed guide (generateStaticParams); a slug
// outside src/lib/docs-index.json is 404 and reads no file.
export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const doc = findDoc((await params).slug);
  return { title: doc ? doc.label : "Documentation" };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const doc = findDoc((await params).slug);
  if (!doc) notFound();
  const source = await readDoc(doc);
  const { title, lead, body } = splitGuide(source);
  const section = DOC_SECTIONS.find((s) => s.links.includes(doc));
  const resolveLink = (href: string) => resolveDocLink(doc, href);

  return (
    <DocsLayout current={doc.slug} toc={headings(source)}>
      <DocHeader
        eyebrow={section?.title ?? "Documentation"}
        title={title ?? doc.label}
        lead={lead && <Markdown source={lead} resolveLink={resolveLink} />}
        meta={`${readingMinutes(source)} min read`}
        aside={
          <>
            <a href={`${REPO_BLOB_URL}/${doc.path}`} className={`${linkClass} ml-auto font-sans font-medium`}>
              View source
            </a>
          </>
        }
      />
      <article className="min-w-0 text-[0.9375rem] text-fg/80">
        <Markdown source={body} resolveLink={resolveLink} />
      </article>
      <DocPager slug={doc.slug} />
    </DocsLayout>
  );
}
