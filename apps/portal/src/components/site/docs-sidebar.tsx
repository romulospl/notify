"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

// Left column of the documentation: a search box that filters the guides by
// title, note and section, and the list of guides. On phones the list stays
// folded behind a button until it is opened or a search is typed.

export type SidebarSection = { title: string; links: { slug: string; label: string; note: string }[] };

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

export function DocsSidebar({ sections, current, base }: { sections: SidebarSection[]; current?: string; base: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // "/" focuses the search, as in most documentation sites.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || target?.closest("input, textarea, [contenteditable]")) return;
      event.preventDefault();
      setOpen(true);
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = fold(query.trim());
  const shown = sections
    .map((section) => ({
      ...section,
      links: q ? section.links.filter((link) => fold(`${section.title} ${link.label} ${link.note}`).includes(q)) : section.links,
    }))
    .filter((section) => section.links.length > 0);

  const item = (active: boolean) =>
    `block py-1.5 text-[0.9375rem] ${active ? "font-medium text-fg" : "text-muted hover:text-fg"}`;
  const label = "font-mono text-xs font-medium tracking-wide text-fg";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-2">
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => event.key === "Escape" && setQuery("")}
          placeholder="Search docs"
          aria-label="Search the documentation"
          className="min-h-10 w-full min-w-0 rounded-control border border-border bg-transparent px-3 font-mono text-xs placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls="docs-guides"
          className="min-h-10 shrink-0 rounded-control border border-border px-3 font-mono text-xs lg:hidden"
        >
          {open ? "Close" : "Guides"}
        </button>
      </div>

      <nav
        id="docs-guides"
        aria-label="Guides"
        className={`${open ? "block" : "hidden"} mt-6 min-h-0 flex-1 overflow-y-auto pb-6 text-sm lg:block`}
      >
        {!q && (
          <div className="mb-8">
            <p className={label}>Getting started</p>
            <ul className="mt-2.5 space-y-1">
              <li>
                <Link href={base} aria-current={current ? undefined : "page"} className={item(!current)}>
                  Overview
                </Link>
              </li>
            </ul>
          </div>
        )}
        {shown.map((section) => (
          <div key={section.title} className="mb-8">
            <p className={label}>{section.title}</p>
            <ul className="mt-2.5 space-y-1">
              {section.links.map((link) => (
                <li key={link.slug}>
                  <Link
                    href={`${base}/${link.slug}`}
                    aria-current={link.slug === current ? "page" : undefined}
                    className={item(link.slug === current)}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {q && shown.length === 0 && <p className="text-muted">No guide matches “{query.trim()}”.</p>}
      </nav>
    </div>
  );
}
