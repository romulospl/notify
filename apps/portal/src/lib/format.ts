// Number and name formatting for the web dashboard (#28, #50). English UI, UTC dates.
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

// Rótulo curto (eixo) e longo (tooltip e tabela) de um balde.
export function bucketLabel(unit: PeriodUnit, at: Date, long = false): string {
  return (long ? BUCKET_LONG : BUCKET_FORMATS)[unit].format(at) + (long && unit === "hour" ? " UTC" : "");
}

export type Delta = { direction: "up" | "down" | "flat"; text: string } | null;

// Variação relativa; nula quando o período anterior não tem base.
export function relativeDelta(current: number, before: number, base = before): Delta {
  if (base <= 0 || before <= 0) return null;
  const change = (current - before) / before;
  if (Math.abs(change) < 0.005) return { direction: "flat", text: "No change" };
  return { direction: change > 0 ? "up" : "down", text: formatPercent(Math.abs(change)) };
}

// Variação em pontos percentuais, para a taxa de rejeição.
export function pointsDelta(current: number, before: number, visits: number, previousVisits: number): Delta {
  if (visits <= 0 || previousVisits <= 0) return null;
  const pts = Math.round((current - before) * 100);
  if (pts === 0) return { direction: "flat", text: "No change" };
  return { direction: pts > 0 ? "up" : "down", text: `${Math.abs(pts)} pts` };
}

// Painel de API (#37). Latência em segundos -> "8.2 ms", "340 ms", "1.25 s".
// O percentil para em 10 s, o último limite do histograma (spec do E5, D2):
// acima disso o valor real é desconhecido, então aparece "≥ 10 s".
export function formatLatency(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds >= 10) return "≥ 10 s";
  if (seconds >= 1) return `${seconds.toFixed(2)} s`;
  const ms = seconds * 1000;
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

// Fração de requisições com erro, com uma casa decimal abaixo de 10%: 0.4% de
// erros de servidor é bem diferente de 0%. Nunca arredonda para 0% ou 100%
// quando não é exato, porque "100% de erros" diz que nada funcionou.
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

// O coletor grava 0 quando o status não veio.
export function statusLabel(code: number): string {
  if (code === 0) return "Unknown";
  const text = STATUS_TEXT[code];
  return text ? `${code} ${text}` : String(code);
}
