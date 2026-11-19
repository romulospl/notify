import type { IconName } from "@/components/ui/icons";

export type ShellMode = "project" | "operator";

export type NavItem = {
  label: string;
  href: string;
  icon: IconName;
  match: readonly string[];
};

export type NavGroup = { label: string; items: readonly NavItem[] };

export const NAV_GROUPS: Record<ShellMode, readonly NavGroup[]> = {
  project: [
    {
      label: "Project",
      items: [
        { label: "Overview", href: "/dashboard", icon: "home", match: ["/dashboard", "/onboarding"] },
        { label: "Websites", href: "/sites", icon: "globe", match: ["/sites"] },
        { label: "API services", href: "/services", icon: "server", match: ["/services"] },
      ],
    },
    {
      label: "Account",
      items: [{ label: "Settings", href: "/settings", icon: "gear", match: ["/settings"] }],
    },
  ],
  operator: [
    {
      label: "SCF operator",
      items: [{ label: "Overview", href: "/operator", icon: "gauge", match: ["/operator", "/operator/tenants"] }],
    },
    {
      label: "Analytics",
      items: [
        { label: "Web analytics", href: "/operator/web", icon: "globe", match: ["/operator/web"] },
        { label: "API analytics", href: "/operator/api", icon: "server", match: ["/operator/api"] },
      ],
    },
    {
      label: "Administration",
      items: [
        { label: "Approvals", href: "/operator/approvals", icon: "check", match: ["/operator/approvals"] },
        { label: "Read API keys", href: "/operator/keys", icon: "key", match: ["/operator/keys"] },
      ],
    },
  ],
};

export function activeHref(mode: ShellMode, pathname: string): string | null {
  let best: { href: string; length: number } | null = null;
  for (const group of NAV_GROUPS[mode]) {
    for (const item of group.items) {
      for (const prefix of item.match) {
        const hit = pathname === prefix || pathname.startsWith(`${prefix}/`);
        if (hit && (!best || prefix.length > best.length)) best = { href: item.href, length: prefix.length };
      }
    }
  }
  return best?.href ?? null;
}

type Crumb = { label: string; href?: string };

const SECTION_LABELS: Record<string, string> = {
  dashboard: "Project",
  onboarding: "Create your project",
  sites: "Websites",
  services: "API services",
  settings: "Settings",
  operator: "SCF overview",
  web: "Web analytics",
  api: "API analytics",
  approvals: "Approvals",
  keys: "Ingest keys",
};

export function breadcrumbs(pathname: string): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "operator") {
    if (parts.length === 1) return [{ label: "SCF overview" }];
    if (parts[1] === "tenants") return [{ label: "SCF overview", href: "/operator" }, { label: "Project" }];
    if (parts[1] === "keys") return [{ label: "Read API keys" }];
    return [{ label: SECTION_LABELS[parts[1] ?? ""] ?? "SCF overview" }];
  }
  if (parts[0] === "sites" && parts.length > 1) return [{ label: "Websites", href: "/sites" }, { label: "Website" }];
  if (parts[0] === "services" && parts.length > 1) {
    const service = { label: "API service", href: `/services/${parts[1]}` };
    if (parts[2] === "keys") return [{ label: "API services", href: "/services" }, service, { label: "Ingest keys" }];
    return [{ label: "API services", href: "/services" }, { label: "API service" }];
  }
  const label = SECTION_LABELS[parts[0] ?? ""];
  return label ? [{ label }] : [];
}
