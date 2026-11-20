// Number and name formatting for the web dashboard (#28, #50). English UI, UTC dates.
import type { PeriodUnit } from "./period";

const full = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// 1,284 up to 9,999; 12.9K from 10,000.
export function formatCount(n: number): string {
  return Math.abs(n) < 10_000 ? full.format(n) : compact.format(n);
}

// Seconds -> "45s", "1m 05s", "2h 03m".
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

// Average visit duration and bounce rate, as Umami itself computes them
// (total time and bounces divided by the visits).
export function averageVisitSeconds(t: { totaltime: number; visits: number }): number {
  return t.visits > 0 ? t.totaltime / t.visits : 0;
}

export function bounceRate(t: { bounces: number; visits: number }): number {
  return t.visits > 0 ? Math.min(t.bounces, t.visits) / t.visits : 0;
}

const regions = new Intl.DisplayNames(["en"], { type: "region" });

// Umami stores the country as a two-letter ISO code.
export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return "Unknown";
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
}

// Umami browser identifiers (detect-browser) -> display name.
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

// Stellar Wallets Kit module IDs (checked in 2.8.0) -> display name. Freighter
// became Varial in kit 2.x; the old ID stays here.
const WALLETS: Record<string, string> = {
  albedo: "Albedo",
  BitgetWallet: "Bitget Wallet",
  cactuslink: "Cactus Link",
  dcent: "D'CENT",
  fordefi: "Fordefi",
  freighter: "Freighter",
  ghostsig: "GhostSig",
  hana: "Hana",
  "hot-wallet": "HOT Wallet",
  klever: "Klever",
  LEDGER: "Ledger",
  lobstr: "LOBSTR",
  onekey: "OneKey",
  rabet: "Rabet",
  scopuly: "Scopuly",
  TREZOR: "Trezor",
  varial: "Varial (Freighter)",
  wallet_connect: "WalletConnect",
  xbull: "xBull",
};

export function walletName(id: string): string {
  if (!id) return "Unknown";
  return WALLETS[id] ?? id;
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

// Short (axis) and long (tooltip and table) label of a bucket.
export function bucketLabel(unit: PeriodUnit, at: Date, long = false): string {
  return (long ? BUCKET_LONG : BUCKET_FORMATS)[unit].format(at) + (long && unit === "hour" ? " UTC" : "");
}

export type Delta = { direction: "up" | "down" | "flat"; text: string } | null;

// Relative change; null when the previous period has no base.
export function relativeDelta(current: number, before: number, base = before): Delta {
  if (base <= 0 || before <= 0) return null;
  const change = (current - before) / before;
  if (Math.abs(change) < 0.005) return { direction: "flat", text: "No change" };
  return { direction: change > 0 ? "up" : "down", text: formatPercent(Math.abs(change)) };
}

// Change in percentage points, for the bounce rate.
export function pointsDelta(current: number, before: number, visits: number, previousVisits: number): Delta {
  if (visits <= 0 || previousVisits <= 0) return null;
  const pts = Math.round((current - before) * 100);
  if (pts === 0) return { direction: "flat", text: "No change" };
  return { direction: pts > 0 ? "up" : "down", text: `${Math.abs(pts)} pts` };
}

// API dashboard (#37). Latency in seconds -> "8.2 ms", "340 ms", "1.25 s".
// The percentile stops at 10 s, the last histogram bound (E5 spec, D2):
// above that the real value is unknown, so "≥ 10 s" is shown.
export function formatLatency(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds >= 10) return "≥ 10 s";
  if (seconds >= 1) return `${seconds.toFixed(2)} s`;
  const ms = seconds * 1000;
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

// Share of requests with an error, with one decimal place below 10%: 0.4% of
// server errors is quite different from 0%. Never rounds to 0% or 100% when
// it is not exact, because "100% errors" says that nothing worked.
export function formatShare(part: number, total: number): string {
  if (total <= 0) return "—";
  const pct = (part / total) * 100;
  if (part > 0 && pct < 0.1) return "< 0.1%";
  const oneDecimal = pct.toFixed(1);
  if (Number(oneDecimal) < 10) return `${oneDecimal}%`;
  const whole = Math.round(pct);
  return whole === 100 && part < total ? "> 99%" : `${whole}%`;
}

const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

// The collector stores 0 when the status did not come.
export function statusLabel(code: number): string {
  if (code === 0) return "Unknown";
  const text = STATUS_TEXT[code];
  return text ? `${code} ${text}` : String(code);
}
