import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import index from "./docs-index.json";

// Guides rendered at /docs/[slug]. They are the Markdown files of the
// repository, read as they are: src/lib/docs-index.json is the only list of
// what can be opened. The slug from the URL is looked up in that list and
// never becomes part of a file path, so nothing outside it can be read.

export type DocLink = { slug: string; label: string; path: string; note: string };
export type DocSection = { title: string; text: string; links: DocLink[] };

export const DOC_SECTIONS: DocSection[] = index;
export const DOCS: DocLink[] = DOC_SECTIONS.flatMap((section) => section.links);

export const REPO_BLOB_URL = "https://github.com/romulospl/stellytics/blob/main";

const bySlug = new Map(DOCS.map((doc) => [doc.slug, doc]));
const byPath = new Map(DOCS.map((doc) => [doc.path, doc]));

export function findDoc(slug: string): DocLink | null {
  return bySlug.get(slug) ?? null;
}

// The portal runs from apps/portal, in development, in tests and in the build.
const REPO_ROOT = path.resolve(process.cwd(), "../..");

// Only read at build time (the pages are prerendered and dynamicParams is
// off), so the files are kept out of output tracing: otherwise the whole
// repository would be copied into the standalone server.
export function readDoc(doc: DocLink): Promise<string> {
  return readFile(path.join(/*turbopackIgnore: true*/ REPO_ROOT, doc.path), "utf8");
}

// Where a link inside a guide goes. A relative link to another listed guide
// stays in the portal; a relative link to anything else in the repository
// opens that file on GitHub. Absolute URLs and anchors are left alone.
export function resolveDocLink(from: DocLink, href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return href;
  const [file = "", hash] = href.split("#", 2);
  const base = href.startsWith("/") ? "" : path.posix.dirname(from.path);
  const target = path.posix.normalize(path.posix.join(base, file)).replace(/^(\.\.\/)+/, "").replace(/\/$/, "");
  const anchor = hash ? `#${hash}` : "";
  const doc = byPath.get(target) ?? byPath.get(`${target}/README.md`);
  return doc ? `/docs/${doc.slug}${anchor}` : `${REPO_BLOB_URL}/${target}${anchor}`;
}
