import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

// Real session check, on the server. proxy.ts only does the quick redirect.
// To read data, use the contexts from lib/access.ts, which start from this function.
export async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  return session;
}
