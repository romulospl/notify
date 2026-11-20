import Link from "next/link";
import { DOCS_URL, GithubMark, REPO_URL, SiteShell } from "@/components/site/site-shell";
import { Icon, type IconName } from "@/components/ui/icons";
import { loadDemoContext } from "@/lib/access";
import { listSites } from "@/lib/data/sites";
import { cachedDemo } from "@/lib/demo-cache";
import { env } from "@/lib/env";
import { trackerScript } from "@/lib/tracker-snippet";

const AUDIENCES: { title: string; text: string; icon: IconName }[] = [
  {
    title: "For projects on Stellar",
    text: "Add a script, collect web and API metrics, and understand how your project is used.",
    icon: "code",
  },
  {
    title: "For SCF operators",
    text: "A unified and comparable view of all enrolled projects.",
    icon: "layers",
  },
  {
    title: "Privacy first",
    text: "No cookies and no browser storage. Each project sees only its own data.",
    icon: "shield",
  },
];

// Decorative waves of the hero, in the accent colours of the theme.
function HeroWaves() {
  return (
    <svg
      viewBox="0 0 800 400"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none absolute top-1/2 right-0 hidden h-[26rem] w-1/2 -translate-y-1/2 xl:block"
    >
      <defs>
        <linearGradient id="wave-a" x1="0" x2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0" />
          <stop offset="0.35" stopColor="var(--accent)" stopOpacity="0.9" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id="wave-b" x1="0" x2="1">
          <stop offset="0" stopColor="#6d5cf0" stopOpacity="0" />
          <stop offset="0.4" stopColor="#6d5cf0" stopOpacity="0.85" />
          <stop offset="1" stopColor="#6d5cf0" stopOpacity="0.15" />
        </linearGradient>
        <linearGradient id="wave-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
        <filter id="wave-glow" x="-10%" y="-50%" width="120%" height="200%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path
        d="M0 330 C120 300 180 160 290 160 S410 230 480 180 S600 80 700 70 S780 110 800 130 L800 400 L0 400 Z"
        fill="url(#wave-fill)"
      />
      <path
        d="M0 330 C120 300 180 160 290 160 S410 230 480 180 S600 80 700 70 S780 110 800 130"
        fill="none"
        stroke="url(#wave-a)"
        strokeWidth="2.5"
        filter="url(#wave-glow)"
      />
      <path
        d="M0 350 C140 330 200 220 310 220 S430 270 520 230 S640 180 720 200 S780 220 800 225"
        fill="none"
        stroke="url(#wave-b)"
        strokeWidth="2.5"
        filter="url(#wave-glow)"
      />
    </svg>
  );
}

// The demo tenant's site registered for the portal's own host, if any: the
// home page installs the tracker for it (the platform measuring itself).
async function ownSiteId(): Promise<{ demo: boolean; websiteId: string | null }> {
  const ctx = await cachedDemo("demo-context", loadDemoContext);
  if (!ctx) return { demo: false, websiteId: null };
  const sites = await cachedDemo(`sites:${ctx.tenantId}`, () => listSites(ctx));
  const host = new URL(env.authUrl).host;
  return { demo: true, websiteId: sites.find((s) => s.domain === host)?.umamiWebsiteId ?? null };
}

// Public home page.
export default async function Home() {
  const { demo, websiteId } = await ownSiteId();
  const script = trackerScript();

  const outlineButton =
    "inline-flex min-h-12 items-center justify-center gap-2.5 rounded-control border border-border-strong px-6 text-base font-semibold text-fg hover:bg-surface-2";

  return (
    <SiteShell>
        <section className="relative py-16 md:py-24">
          <HeroWaves />
          <div className="relative max-w-3xl">
            <p className="inline-flex items-center gap-2 rounded-full border border-accent/70 bg-accent-soft/40 px-4 py-1.5 text-sm font-semibold text-accent-text">
              <Icon name="sparkle" className="size-3.5" />
              Analytics for the Stellar ecosystem
            </p>
            <h1 className="mt-6 text-4xl leading-[1.08] font-bold tracking-tight md:text-6xl">
              Web and API analytics for Stellar ecosystem projects.
            </h1>
            <p className="mt-6 max-w-2xl text-lg text-muted md:text-xl">
              stellytics is an open-source, multi-tenant analytics platform for the Stellar Community Fund. Get a clear
              and comparable view of project usage, with privacy by design.
            </p>
            <div className="mt-10 flex flex-wrap gap-4">
              <Link
                href="/demo"
                className="inline-flex min-h-12 items-center justify-center gap-2.5 rounded-control bg-accent px-7 text-base font-semibold text-accent-fg hover:brightness-110"
              >
                <Icon name="play" className="size-4" />
                Live demo
              </Link>
              <a href={REPO_URL} className={outlineButton}>
                <GithubMark className="size-5" />
                GitHub
              </a>
              <a href={DOCS_URL} className={outlineButton}>
                <Icon name="doc" className="size-5" />
                Docs
              </a>
            </div>
            <p className="mt-4 text-sm text-muted">
              No account needed: the demo shows {demo ? "this site\u2019s own traffic" : "sample data"}.
            </p>
          </div>
        </section>

        <ul id="features" className="grid scroll-mt-6 gap-8 py-10 md:grid-cols-3 md:gap-0 md:divide-x md:divide-border">
          {AUDIENCES.map((item) => (
            <li key={item.title} className="flex gap-6 md:px-8 md:first:pl-0 md:last:pr-0">
              <span className="grid size-16 shrink-0 place-items-center rounded-xl bg-accent-soft/60 text-accent-text">
                <Icon name={item.icon} className="size-8" />
              </span>
              <div>
                <h2 className="text-lg font-bold">{item.title}</h2>
                <p className="mt-1.5 text-muted">{item.text}</p>
              </div>
            </li>
          ))}
        </ul>
      {websiteId && (
        <script defer src={script.src} integrity={script.integrity} crossOrigin="anonymous" data-site={websiteId} />
      )}
    </SiteShell>
  );
}
