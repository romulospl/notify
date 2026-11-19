import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";

const POINTS = ["No cookies, no personal data", "Wallet addresses are never shown", "Web and API analytics in one place"];

function BrandPanel() {
  return (
    <aside className="relative hidden flex-col justify-between overflow-hidden bg-art-bg p-10 text-art-fg min-[960px]:flex">
      <svg className="absolute inset-0 size-full" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id="auth-art-glow" cx="30%" cy="20%" r="80%">
            <stop offset="0" stopColor="var(--art-glow)" stopOpacity=".55" />
            <stop offset="1" stopColor="var(--art-bg)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="600" height="800" fill="url(#auth-art-glow)" />
        <g stroke="var(--art-line)" strokeOpacity=".35" fill="none">
          <circle cx="360" cy="140" r="90" />
          <circle cx="360" cy="140" r="150" strokeDasharray="3 6" />
        </g>
        <g fill="var(--art-dot)">
          {[
            [60, 620, 3],
            [180, 530, 4],
            [320, 570, 3],
            [420, 440, 4],
            [540, 500, 3],
            [150, 380, 3],
            [300, 310, 4],
            [360, 140, 5],
          ].map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
          ))}
        </g>
      </svg>
      <Link href="/sign-in" className="relative w-fit text-white">
        <Logo className="h-8 w-auto" />
      </Link>
      <div className="relative">
        <h2 className="max-w-88 text-[2rem] leading-tight font-semibold tracking-tight">Know how your Stellar project is used.</h2>
        <p className="mt-3 max-w-104 text-base text-art-muted">
          Privacy-first analytics for projects building on Stellar, built for the Stellar Community Fund.
        </p>
        <ul className="mt-5 grid gap-2">
          {POINTS.map((point) => (
            <li key={point} className="flex items-center gap-2">
              <span aria-hidden="true">✓</span>
              {point}
            </li>
          ))}
        </ul>
      </div>
      <p className="relative text-[0.8125rem] text-art-muted">Used by SCF operators to compare projects with numbers they can trust.</p>
    </aside>
  );
}

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-dvh min-[960px]:grid-cols-2">
      <BrandPanel />
      <main className="grid place-items-center px-4 py-8">
        <div className="grid w-full max-w-sm gap-5">
          <div className="flex items-center justify-between">
            <Link href="/sign-in" className="text-fg min-[960px]:invisible">
              <Logo className="h-8 w-auto" />
            </Link>
            <ThemeToggle />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
