import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "notify", template: "%s · notify" },
  description: "Web and API analytics for Stellar ecosystem projects",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        {children}
      </body>
    </html>
  );
}
