"use client";

import { Icon } from "@/components/ui/icons";

const STORAGE_KEY = "stellytics-theme";

export function ThemeToggle() {
  return (
    <button
      type="button"
      aria-label="Toggle light and dark theme"
      onClick={() => {
        const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {}
      }}
      className="inline-grid size-9 place-items-center rounded-control hover:bg-surface-2"
    >
      <span className="dark:hidden">
        <Icon name="moon" />
      </span>
      <span className="hidden dark:inline">
        <Icon name="sun" />
      </span>
    </button>
  );
}
