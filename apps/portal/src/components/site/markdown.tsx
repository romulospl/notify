import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/site/mermaid-diagram";
import { linkClass } from "@/components/ui/button";

// Renders a Markdown guide (/docs/[slug]) with the portal's own styles.
// react-markdown does not render raw HTML and drops unsafe URLs by default;
// both defaults are kept. remark-gfm adds tables, task lists and strikethrough,
// which the guides use.

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return "";
}

// Same ids GitHub gives headings, so the anchors written in the guides work.
export function headingId(children: ReactNode): string {
  return text(children)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export type Heading = { depth: 2 | 3; text: string; id: string };

// Level 2 and 3 headings of a guide, for its "On this page" list. Read from
// the source lines (code blocks skipped) with the inline Markdown removed,
// so each id is the one headingId gives the rendered heading.
export function headings(source: string): Heading[] {
  const out: Heading[] = [];
  let fence = "";
  for (const line of source.split("\n")) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      continue;
    }
    const match = !fence && line.match(/^(#{2,3})\s+(.+?)(?:\s+#+)?\s*$/);
    const [, hashes = "", raw = ""] = match || [];
    if (!raw) continue;
    const plain = raw
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|\*)(\S(?:.*?\S)?)\1/g, "$2")
      .replace(/\\([^\w\s])/g, "$1");
    out.push({ depth: hashes.length as 2 | 3, text: plain, id: headingId(plain) });
  }
  return out;
}

// The top of a guide for its page header: the H1 as the title and, when the
// next block is a plain paragraph, that paragraph as the lead. The body is
// the rest of the file. A guide without an H1 keeps its whole source as body.
export function splitGuide(source: string): { title: string | null; lead: string | null; body: string } {
  const match = source.match(/^\s*# +(.+?)\s*\n/);
  if (!match) return { title: null, lead: null, body: source };
  const rest = source.slice(match[0].length).replace(/^\s*\n/, "");
  const block = rest.split(/\n\s*\n/, 1)[0] ?? "";
  const plain = block && !/^(\s{0,3}([#>|*+-]|\d+[.)]|`{3}|~{3})|\s{4})/.test(block);
  return {
    title: match[1] ?? null,
    lead: plain ? block : null,
    body: plain ? rest.slice(block.length) : rest,
  };
}

// Reading time shown under a guide's title, at 200 words a minute.
export function readingMinutes(source: string): number {
  return Math.max(1, Math.round(source.split(/\s+/).filter(Boolean).length / 200));
}

export function Markdown({ source, resolveLink }: { source: string; resolveLink: (href: string) => string }) {
  const mono = "scroll-mt-10 font-mono font-normal tracking-tight text-fg";
  const components: Components = {
    h1: ({ children }) => <h1 className={`${mono} mt-14 text-3xl`}>{children}</h1>,
    h2: ({ children }) => (
      <h2 id={headingId(children)} className={`${mono} mt-14 text-2xl`}>
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 id={headingId(children)} className={`${mono} mt-10 text-lg`}>
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 id={headingId(children)} className="mt-6 scroll-mt-10 font-semibold text-fg">
        {children}
      </h4>
    ),
    p: ({ children }) => <p className="mt-4 leading-7">{children}</p>,
    strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
    a: ({ href, children }) => {
      const to = resolveLink(href ?? "");
      const external = /^https?:/i.test(to);
      return (
        <a href={to} className={`${linkClass} break-words`} {...(external ? { rel: "noopener noreferrer" } : {})}>
          {children}
        </a>
      );
    },
    // Bullet lists get the "+" rows of globals.css (.docs-list).
    ul: ({ children }) => <ul className="docs-list">{children}</ul>,
    ol: ({ children }) => <ol className="mt-4 list-decimal space-y-2 pl-6 leading-7 marker:font-mono marker:text-muted">{children}</ol>,
    li: ({ children }) => <li className="[&>ol]:mt-2 [&>p:first-child]:mt-0 [&>p]:mt-2">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="mt-6 border-l-2 border-accent bg-surface-2/60 px-4 py-1 pb-4 text-sm">{children}</blockquote>
    ),
    hr: () => <hr className="mt-10 border-border" />,
    // A ```mermaid block is drawn as a diagram; any other block stays as code.
    pre: ({ children }) => {
      const block = Children.toArray(children)[0];
      if (isValidElement<{ className?: string; children?: ReactNode }>(block) && /\blanguage-mermaid\b/.test(block.props.className ?? "")) {
        return <MermaidDiagram source={text(block.props.children).replace(/\n$/, "")} />;
      }
      return (
      <pre className="mt-5 overflow-x-auto rounded-control border border-border bg-surface-2 p-4 font-mono text-xs leading-relaxed text-fg [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[length:inherit]">
        {children}
      </pre>
      );
    },
    code: ({ children }) => (
      <code className="rounded-[0.25rem] border border-border bg-surface-2 px-1 py-0.5 font-mono text-[0.85em] break-words text-fg">{children}</code>
    ),
    table: ({ children }) => (
      <div className="mt-5 overflow-x-auto border-y border-border">
        <table className="w-full min-w-[32rem] text-left text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="border-b border-border font-mono text-xs text-fg">{children}</thead>,
    tbody: ({ children }) => <tbody className="divide-y divide-border">{children}</tbody>,
    th: ({ children }) => <th className="px-3 py-2.5 align-top font-medium">{children}</th>,
    td: ({ children }) => <td className="px-3 py-2.5 align-top">{children}</td>,
    // The guides have no images of their own; a remote one is never loaded.
    img: ({ alt }) => (Children.count(alt) > 0 ? <span className="text-muted">[{alt}]</span> : null),
  };
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {source}
    </ReactMarkdown>
  );
}
