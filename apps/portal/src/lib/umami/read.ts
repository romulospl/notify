import "server-only";
import type { Period } from "../period";
import { umamiRequest } from "./http";

// Leituras do Umami pelo ID do site no Umami. INTERNO a src/lib/umami/: quem
// chama já conferiu de onde veio o ID (o site do tenant, em stats.ts, ou a
// lista de projetos ativos do operador, em overview.ts). A regra de lint
// proíbe importar este arquivo fora de src/lib/umami/, como o http.ts, porque
// o spec do E2 (seção 4) não deixa função pública aceitar o ID do Umami.
//
// Formato conferido no Umami 3.4.1 (ADR 0001): `y` do /metrics conta
// visitantes; /pageviews só devolve os baldes com dados.

export type Totals = {
  pageviews: number;
  visitors: number;
  visits: number;
  bounces: number;
  totaltime: number;
};

export type SiteStats = Totals & { comparison: Totals };

export type Point = { x: string | null; y: number };

export const BREAKDOWNS = ["referrer", "country", "device", "browser"] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];

function range(period: Pick<Period, "startAt" | "endAt">): string {
  return `startAt=${period.startAt.getTime()}&endAt=${period.endAt.getTime()}`;
}

export function readStats(umamiWebsiteId: string, period: Pick<Period, "startAt" | "endAt">) {
  return umamiRequest<SiteStats>(`/api/websites/${umamiWebsiteId}/stats?${range(period)}`);
}

export function readSeries(umamiWebsiteId: string, period: Period) {
  return umamiRequest<{ pageviews: Point[]; sessions: Point[] }>(
    `/api/websites/${umamiWebsiteId}/pageviews?${range(period)}&unit=${period.unit}&timezone=UTC`,
  );
}

export function readBreakdown(umamiWebsiteId: string, type: Breakdown, period: Period, limit: number) {
  return umamiRequest<Point[]>(`/api/websites/${umamiWebsiteId}/metrics?${range(period)}&type=${type}&limit=${limit}`);
}

// Custom events (#50). In Umami 3.4.1, /metrics?type=event returns only custom
// events and `y` counts events (count(*)), not visitors.
export function readEvents(umamiWebsiteId: string, period: Period, limit: number) {
  return umamiRequest<Point[]>(`/api/websites/${umamiWebsiteId}/metrics?${range(period)}&type=event&limit=${limit}`);
}

// Count per value of one event property (/event-data/values in 3.4.1: `total`
// counts events, at most 100 values, in descending order).
export type PropertyValue = { value: string; total: number };

export function readEventValues(umamiWebsiteId: string, period: Period, eventName: string, propertyName: string) {
  const query = new URLSearchParams({ eventName, propertyName });
  return umamiRequest<PropertyValue[]>(`/api/websites/${umamiWebsiteId}/event-data/values?${range(period)}&${query}`);
}
