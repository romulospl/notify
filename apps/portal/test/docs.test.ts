// Guides rendered at /docs/[slug] with react-markdown: the list is closed, every
// listed file exists and renders, and links inside a guide go to the right place.
import { existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { headingId, headings, Markdown, readingMinutes, splitGuide } from "@/components/site/markdown";
import { DOCS, findDoc, readDoc, REPO_BLOB_URL, resolveDocLink } from "@/lib/docs";

const repo = path.join(import.meta.dirname, "..", "..", "..");
const render = (source: string, resolveLink: (href: string) => string = (href) => href) =>
  renderToStaticMarkup(Markdown({ source, resolveLink }));

describe("documentation guides", () => {
  it("the list has unique slugs and every file exists and is copied into the image build", async () => {
    expect(new Set(DOCS.map((d) => d.slug)).size).toBe(DOCS.length);
    const { readFileSync } = await import("node:fs");
    const dockerfile = readFileSync(path.join(repo, "apps/portal/Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY docs/guide docs/guide");
    for (const doc of DOCS) {
      expect(doc.slug).toMatch(/^[a-z0-9-]+$/);
      expect(doc.path.endsWith(".md"), doc.path).toBe(true);
      expect(existsSync(path.join(repo, doc.path)), doc.path).toBe(true);
      // The image copies only docs/guide, so every guide must live there.
      expect(doc.path.startsWith("docs/guide/"), doc.path).toBe(true);
    }
  });

  it("the script tag in the guides is the newest published version, with its hash", async () => {
    const { readFileSync } = await import("node:fs");
    const sri: Record<string, string> = JSON.parse(readFileSync(path.join(repo, "packages/tracker/published/sri.json"), "utf8"));
    const { TRACKER_VERSION } = await import("@/lib/tracker-snippet");
    for (const slug of ["quickstart", "script-tag"]) {
      const source = await readDoc(findDoc(slug)!);
      expect(source, slug).toContain(`/s/v${TRACKER_VERSION}/n.js`);
      expect(source, slug).toContain(`integrity="${sri[TRACKER_VERSION]}"`);
    }
  });

  it("only listed slugs open: a path in the URL is not a slug", () => {
    expect(findDoc("quickstart")?.path).toBe("docs/guide/quickstart.md");
    for (const slug of ["", "nope", "../../.env", "docs/deploy.md", "..%2F..%2F.env", "deploy/../../.env"]) {
      expect(findDoc(slug), slug).toBeNull();
    }
  });

  it.each(DOCS.map((d) => [d.slug, d] as const))("%s renders", async (_slug, doc) => {
    const html = render(await readDoc(doc), (href) => resolveDocLink(doc, href));
    expect(html).toContain("<h1");
    // Raw HTML in a guide is never passed through.
    expect(html).not.toMatch(/<script|<iframe|javascript:/i);
  });

  it.each(DOCS.map((d) => [d.slug, d] as const))("%s: the page outline links to the rendered headings", async (_slug, doc) => {
    const source = await readDoc(doc);
    const html = render(source);
    const rendered = [...html.matchAll(/<h([23]) id="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(headings(source).map((h) => `${h.depth}:${h.id}`)).toEqual(rendered);
  });

  it("the outline skips code blocks and strips inline Markdown", () => {
    const outline = headings("# T\n\n## The `init.sh` [script](x.md) **now**\n\n```sh\n## not a heading\n```\n\n### 3.4 Custom events ##\n");
    expect(outline).toEqual([
      { depth: 2, text: "The init.sh script now", id: "the-initsh-script-now" },
      { depth: 3, text: "3.4 Custom events", id: "34-custom-events" },
    ]);
  });

  it("the page header takes the H1 as title and a plain first paragraph as lead", () => {
    expect(splitGuide("# Deploy\n\nOne VPS.\nTwo lines.\n\n## Next\n")).toEqual({
      title: "Deploy",
      lead: "One VPS.\nTwo lines.",
      body: "\n\n## Next\n",
    });
    // A list, quote, table or heading right after the title stays in the body.
    for (const block of ["- item", "> **Status.** x", "| a |", "## Next", "**Bold** start", "```sh"]) {
      expect(splitGuide(`# T\n\n${block}\n`), block).toMatchObject({ title: "T", lead: null });
    }
    expect(splitGuide("No title\n")).toEqual({ title: null, lead: null, body: "No title\n" });
    expect(readingMinutes("word ".repeat(1000))).toBe(5);
    expect(readingMinutes("")).toBe(1);
  });

  it.each(DOCS.map((d) => [d.slug, d] as const))("%s has a title for its page header", async (_slug, doc) => {
    expect(splitGuide(await readDoc(doc)).title).toBeTruthy();
  });

  it("renders GFM tables and code, and drops raw HTML and unsafe links", () => {
    const html = render("# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n## 6. Next steps");
    expect(html).toContain("<table");
    expect(html).toContain("const x = 1;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('id="6-next-steps"');
    expect(headingId("3.4.1 Custom events (v1.2.0 or newer)")).toBe("341-custom-events-v120-or-newer");
  });

  it("links inside a guide: listed guides stay in the portal, the rest goes to GitHub", () => {
    const otel = findDoc("opentelemetry")!;
    expect(resolveDocLink(otel, "route-normalization.md")).toBe("/docs/route-normalization");
    expect(resolveDocLink(otel, "custom-events.md#rules")).toBe("/docs/custom-events#rules");
    // The long guides stay in the repository and open on GitHub.
    expect(resolveDocLink(otel, "../privacy.md")).toBe(`${REPO_BLOB_URL}/docs/privacy.md`);
    expect(resolveDocLink(otel, "../../examples/api-backend/README.md")).toBe(`${REPO_BLOB_URL}/examples/api-backend/README.md`);
    // Climbing above the repository root does not leave it.
    expect(resolveDocLink(otel, "../../../../etc/passwd")).toBe(`${REPO_BLOB_URL}/etc/passwd`);
    for (const href of ["https://example.org/x", "#section", "mailto:a@example.org"]) expect(resolveDocLink(otel, href)).toBe(href);
  });
});
