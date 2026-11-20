"use client";

import { useState } from "react";

// Where a service sends its metrics (self-service enrollment): the collector's
// OTLP address and the header that carries the ingest key. Shown on the
// "Ingest keys" tab, because the key itself is only shown once.
export function OtlpEndpoint({ url }: { url: string }) {
  const [copied, setCopied] = useState<"url" | "header" | null>(null);
  const header = "Authorization: Bearer <your ingest key>";
  const row = (label: string, value: string, key: "url" | "header") => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <code className="break-all rounded bg-surface-2 px-2 py-1 font-mono">{value}</code>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(key);
        }}
        className="rounded-control border border-border-strong px-3 py-1 hover:bg-surface-2"
      >
        {copied === key ? "Copied" : "Copy"}
      </button>
    </div>
  );

  return (
    <div className="mt-6 rounded-card border border-border p-4 text-sm">
      <h2 className="font-medium">Where to send metrics</h2>
      <div className="mt-3 space-y-2">
        {row("Endpoint", url, "url")}
        {row("Header", header, "header")}
      </div>
      <p className="mt-3 text-muted">
        Point your OpenTelemetry OTLP exporter at this endpoint (OTLP/HTTP or gRPC; HTTP exporters add{" "}
        <code>/v1/metrics</code>) and send the <code>http.server.request.duration</code> metric or HTTP server spans.
      </p>
    </div>
  );
}
