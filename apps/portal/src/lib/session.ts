import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "./auth";

// Verificação real da sessão, no servidor. O proxy.ts só faz o redirecionamento rápido.
export async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  return session;
}

export async function requireOperator() {
  const session = await requireSession();
  // 404 em vez de 403 para não revelar que a área existe.
  if (session.user.role !== "operator") notFound();
  return session;
}
