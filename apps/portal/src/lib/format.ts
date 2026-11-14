// Formatação dos números e nomes do painel web (#28). Interface em inglês, datas em UTC.
import type { PeriodUnit } from "./period";

const full = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// 1,284 até 9.999; 12.9K a partir de 10.000.
export function formatCount(n: number): string {
  return Math.abs(n) < 10_000 ? full.format(n) : compact.format(n);
}

// Segundos -> "45s", "1m 05s", "2h 03m".
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

// Duração média da visita e taxa de rejeição, como o próprio Umami calcula
// (tempo total e rejeições divididos pelas visitas).
export function averageVisitSeconds(t: { totaltime: number; visits: number }): number {
  return t.visits > 0 ? t.totaltime / t.visits : 0;
}

export function bounceRate(t: { bounces: number; visits: number }): number {
  return t.visits > 0 ? Math.min(t.bounces, t.visits) / t.visits : 0;
}

const regions = new Intl.DisplayNames(["en"], { type: "region" });

// O Umami grava o país como código ISO de duas letras.
export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return "Unknown";
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
}

// Identificadores de navegador do Umami (detect-browser) -> nome de exibição.
const BROWSERS: Record<string, string> = {
  chrome: "Chrome",
  crios: "Chrome (iOS)",
  firefox: "Firefox",
  fxios: "Firefox (iOS)",
  safari: "Safari",
  ios: "Safari (iOS)",
  "ios-webview": "iOS WebView",
  "edge-chromium": "Edge",
  edge: "Edge (legacy)",
  "edge-ios": "Edge (iOS)",
  opera: "Opera",
  "opera-mini": "Opera Mini",
  samsung: "Samsung Internet",
  "chromium-webview": "Android WebView",
  android: "Android Browser",
  yandexbrowser: "Yandex Browser",
  brave: "Brave",
  vivaldi: "Vivaldi",
  instagram: "Instagram",
  facebook: "Facebook",
};

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function browserName(id: string): string {
  if (!id) return "Unknown";
  return BROWSERS[id] ?? capitalize(id.replace(/-/g, " "));
}

export function deviceName(id: string): string {
  return id ? capitalize(id) : "Unknown";
}

export function referrerName(domain: string): string {
  return domain || "Direct";
}

const BUCKET_FORMATS: Record<PeriodUnit, Intl.DateTimeFormat> = {
  hour: new Intl.DateTimeFormat("en", { hour: "numeric", timeZone: "UTC" }),
  day: new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }),
  month: new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" }),
};

const BUCKET_LONG: Record<PeriodUnit, Intl.DateTimeFormat> = {
  hour: new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }),
  day: new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }),
  month: new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }),
};

// Rótulo curto (eixo) e longo (tooltip e tabela) de um balde.
export function bucketLabel(unit: PeriodUnit, at: Date, long = false): string {
  return (long ? BUCKET_LONG : BUCKET_FORMATS)[unit].format(at) + (long && unit === "hour" ? " UTC" : "");
}
