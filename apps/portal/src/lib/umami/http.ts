import "server-only";
import { env } from "../env";

// The only place in the portal that speaks HTTP with Umami (#58). Only the
// modules in src/lib/umami/ import this file; ESLint forbids the rest of the
// code. The credential is the service account's API key, from UMAMI_API_KEY.

export class UmamiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UmamiError";
  }
}

const TIMEOUT_MS = 10_000;

export async function umamiRequest<T>(
  path: string,
  { method = "GET", body }: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${env.umamiUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.umamiApiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new UmamiError(`Umami ${method} ${path}: no response (${(error as Error).name})`);
  }
  // The message carries neither the response body nor the key.
  if (!response.ok) {
    throw new UmamiError(`Umami ${method} ${path}: ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}
