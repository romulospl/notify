"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  createKeyAction,
  createServiceAction,
  type KeyActionState,
  revokeKeyAction,
} from "./actions";

const idle: KeyActionState = { status: "idle" };

const input =
  "mt-1 block w-full rounded-control border border-border-strong bg-transparent px-3 py-2 text-sm outline-none focus:border-accent";
const primary =
  "rounded-control bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:brightness-110 disabled:opacity-60";
const secondary =
  "rounded-control border border-border-strong px-3 py-1 text-sm hover:bg-surface-2 disabled:opacity-60";

// Mostra a chave recém-criada. Ela só existe aqui, até sair da página.
function KeyReveal({ state }: { state: KeyActionState }) {
  const [copied, setCopied] = useState(false);
  if (state.status === "error") {
    return (
      <p role="alert" className="mt-3 text-sm text-bad">
        {state.message}
      </p>
    );
  }
  if (state.status !== "created") return null;
  return (
    <div className="mt-4 rounded-control border border-warn/30 bg-warn-soft p-4 text-sm">
      <p className="font-medium">Copy your ingest key now. It won&apos;t be shown again.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-surface px-2 py-1 font-mono">{state.key}</code>
        <button
          type="button"
          className={secondary}
          onClick={async () => {
            await navigator.clipboard.writeText(state.key);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-2 text-muted">
        Send it as <code>Authorization: Bearer &lt;key&gt;</code> in your OTLP exporter.
      </p>
    </div>
  );
}

export function CreateServiceForm() {
  const [state, action, pending] = useActionState(createServiceAction, idle);
  return (
    <div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="block min-w-64 flex-1">
          <span className="text-sm font-medium">Service name</span>
          <input name="name" required maxLength={100} placeholder="horizon-proxy" className={input} />
        </label>
        <button type="submit" disabled={pending} className={primary}>
          {pending ? "Creating…" : "Create service"}
        </button>
      </form>
      <KeyReveal state={state} />
      {state.status === "created" && (
        <Link href={`/services/${state.serviceId}/keys`} className="mt-2 inline-block text-sm underline">
          Manage this service&apos;s keys
        </Link>
      )}
    </div>
  );
}

export function CreateKeyButton({ serviceId, disabled }: { serviceId: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(createKeyAction.bind(null, serviceId), idle);
  return (
    <div>
      <form action={action}>
        <button type="submit" disabled={pending || disabled} className={primary}>
          {pending ? "Creating…" : "Create key"}
        </button>
      </form>
      <KeyReveal state={state} />
    </div>
  );
}

export function RevokeKeyButton({ keyId, prefix }: { keyId: string; prefix: string }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      className={secondary}
      onClick={async () => {
        if (!window.confirm(`Revoke key ${prefix}? Clients using it stop sending data within a minute.`)) return;
        setPending(true);
        await revokeKeyAction(keyId);
        setPending(false);
      }}
    >
      {pending ? "Revoking…" : "Revoke"}
    </button>
  );
}
