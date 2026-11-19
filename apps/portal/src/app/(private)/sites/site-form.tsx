"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { inputClass } from "@/components/ui/field";
import { createSiteAction, type SiteActionState } from "./actions";

const initial: SiteActionState = { status: "idle" };

export function SiteForm() {
  const [state, action, pending] = useActionState(createSiteAction, initial);
  const router = useRouter();

  // After adding, open the new site's page: the next step is installing the
  // script shown there.
  useEffect(() => {
    if (state.status === "created") router.push(`/sites/${state.siteId}#install`);
  }, [state, router]);

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="block min-w-48 flex-1">
        <span className="text-sm font-medium">Name</span>
        <input name="name" required maxLength={100} placeholder="Docs" className={inputClass} />
      </label>
      <label className="block min-w-64 flex-1">
        <span className="text-sm font-medium">Domain</span>
        <input name="domain" required maxLength={500} placeholder="docs.example.org" className={inputClass} />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-control bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:brightness-110 disabled:opacity-60"
      >
        {pending ? "Adding…" : "Add website"}
      </button>
      {state.status === "error" && (
        <p role="alert" className="w-full text-sm text-bad">
          {state.message}
        </p>
      )}
    </form>
  );
}
