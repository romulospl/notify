"use client";

import { useEffect, useState } from "react";
import type { Heading } from "@/components/site/markdown";

// Right column of a guide: its headings, with the one being read marked.
// The mark follows the last heading that has scrolled past the top.

export function OnThisPage({ items }: { items: Heading[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");

  useEffect(() => {
    const targets = items.map((heading) => document.getElementById(heading.id)).filter((el) => el !== null);
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = targets[0]?.id ?? "";
      for (const el of targets) {
        if (el.getBoundingClientRect().top > 120) break;
        current = el.id;
      }
      // At the end of the page the last headings may never reach the top.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) current = targets.at(-1)?.id ?? current;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [items]);

  return (
    <nav aria-label="On this page" className="sticky top-10 max-h-[calc(100dvh-5rem)] overflow-y-auto pb-6 text-sm">
      <p className="font-mono text-xs font-medium tracking-wide">On this page</p>
      <ul className="mt-4 space-y-2.5">
        {items.map((heading, i) => {
          const on = heading.id === active;
          return (
            <li key={`${heading.id}-${i}`} className={heading.depth === 3 ? "pl-4" : ""}>
              <a
                href={`#${heading.id}`}
                aria-current={on ? "location" : undefined}
                className={`relative block pl-4 leading-snug ${on ? "text-fg" : "text-muted hover:text-fg"}`}
              >
                {on && (
                  <span aria-hidden="true" className="absolute left-0 text-accent-text">
                    ›
                  </span>
                )}
                {heading.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
