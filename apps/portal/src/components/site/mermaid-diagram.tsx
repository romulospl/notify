"use client";

import { useEffect, useId, useState } from "react";

// Draws a ```mermaid block of a guide as a diagram. The library is loaded in
// the browser only when a guide has a diagram, and runs with its default
// strict security level, which sanitizes the labels. Until the drawing is
// ready, or if the source does not parse, the source is shown as a code block.

const preClass =
  "mt-5 overflow-x-auto rounded-control border border-border bg-surface-2 p-4 font-mono text-xs leading-relaxed text-fg";

// Colours come from the portal's own tokens (globals.css), read at drawing
// time so the diagram follows the light or dark theme in use.
function themeVariables() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: token("--surface"),
    primaryColor: token("--surface-2"),
    primaryTextColor: token("--fg"),
    primaryBorderColor: token("--border-strong"),
    secondaryColor: token("--accent-soft"),
    tertiaryColor: token("--surface"),
    lineColor: token("--muted"),
    textColor: token("--fg"),
    mainBkg: token("--surface-2"),
    clusterBkg: token("--surface"),
    clusterBorder: token("--border"),
    edgeLabelBackground: token("--surface"),
    actorBkg: token("--surface-2"),
    actorBorder: token("--border-strong"),
    actorTextColor: token("--fg"),
    signalColor: token("--muted"),
    signalTextColor: token("--fg"),
    labelBoxBkgColor: token("--surface-2"),
    noteBkgColor: token("--accent-soft"),
    noteBorderColor: token("--border-strong"),
    noteTextColor: token("--fg"),
    fontFamily: getComputedStyle(document.body).fontFamily,
  };
}

export function MermaidDiagram({ source }: { source: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const draw = async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: themeVariables() });
        const result = await mermaid.render(id, source);
        if (current) setSvg(result.svg);
      } catch {
        // A failed drawing leaves a helper node behind; the source stays visible.
        document.getElementById(`d${id}`)?.remove();
        if (current) setSvg(null);
      }
    };
    void draw();

    // Draw again when the theme changes: by the portal's switch (data-theme
    // on the root element) or by the system preference.
    const observer = new MutationObserver(() => void draw());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMedia = () => void draw();
    media.addEventListener("change", onMedia);
    return () => {
      current = false;
      observer.disconnect();
      media.removeEventListener("change", onMedia);
    };
  }, [id, source]);

  if (svg === null) {
    return (
      <pre className={preClass}>
        <code>{source}</code>
      </pre>
    );
  }
  return (
    <div
      role="img"
      aria-label="Diagram"
      className="mt-5 overflow-x-auto rounded-control border border-border bg-surface p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
