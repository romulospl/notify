import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "./db";
import { operatorApiKey, operatorInvite, tenant, tenantMember, user } from "./db/schema";
import { READ_KEY_PATTERN, readKeyFromHeader } from "./read-key";
import { requireSession } from "./session";

// Contextos de acesso do spec do E2, seção 4 (ADR 0003). O tenant vem sempre
// da sessão, nunca de um valor enviado pelo cliente.
//
// Os tipos são marcados (branded): fora deste arquivo ninguém consegue montar
// um contexto à mão, então as funções de src/lib/data/ e src/lib/umami/ só
// recebem contextos criados aqui, a partir da sessão. Junto com a regra de
// lint (eslint.config.mjs), isso faz de data/ e umami/ a camada única.
//
// Quem não tem acesso recebe 404, nunca 403, para não revelar que o recurso
// ou a área existe.

declare const tenantContextBrand: unique symbol;
declare const operatorContextBrand: unique symbol;

export type TenantContext = {
  readonly userId: string;
  readonly tenantId: string;
  readonly memberRole: "owner" | "member";
  readonly tenantStatus: "active" | "removed" | "pending";
  readonly [tenantContextBrand]: true;
};

export type OperatorContext = {
  readonly userId: string;
  readonly [operatorContextBrand]: true;
};

// Busca o tenant do usuário (D1: no máximo um). Nulo para quem não é membro.
// Não confere o papel: use getTenantContext() ou requireTenantContext().
export async function loadTenantContext(userId: string): Promise<TenantContext | null> {
  const [row] = await db
    .select({ tenantId: tenantMember.tenantId, memberRole: tenantMember.role, tenantStatus: tenant.status })
    .from(tenantMember)
    .innerJoin(tenant, eq(tenant.id, tenantMember.tenantId))
    .where(eq(tenantMember.userId, userId))
    .limit(1);
  if (!row) return null;
  return { userId, ...row } as TenantContext;
}

// Contexto do tenant de quem está na sessão, ou nulo para quem ainda não tem
// projeto. Sem sessão vai para o login; operador recebe 404 (D2: operador não
// é membro de tenant).
export async function getTenantContext(): Promise<TenantContext | null> {
  const session = await requireSession();
  if (session.user.role === "operator") notFound();
  return loadTenantContext(session.user.id);
}

// Quem ainda não tem projeto vai para a criação do projeto (#17). Projeto
// `pending` (cadastro com aprovação, #49) só vê a tela de espera em /dashboard,
// que pede `allowPending`; qualquer outra página ou ação do tenant redireciona
// para lá, então nenhuma delas chega à camada de dados.
export async function requireTenantContext(options: { allowPending?: boolean } = {}): Promise<TenantContext> {
  const ctx = await getTenantContext();
  if (!ctx) redirect("/onboarding");
  if (ctx.tenantStatus === "pending" && !options.allowPending) redirect("/dashboard");
  return ctx;
}

// Quem pode criar um projeto (#17): membro com e-mail confirmado e ainda sem
// tenant (D1: um tenant por usuário). Quem já tem projeto vai para o painel.
declare const onboardingContextBrand: unique symbol;

export type OnboardingContext = {
  readonly userId: string;
  readonly [onboardingContextBrand]: true;
};

export async function requireOnboardingContext(): Promise<OnboardingContext> {
  const session = await requireSession();
  if (session.user.role === "operator") notFound();
  // O login já exige e-mail confirmado (#60); conferir de novo aqui garante
  // que conta sem confirmação nunca cria projeto.
  if (!session.user.emailVerified) notFound();
  if (await loadTenantContext(session.user.id)) redirect("/dashboard");
  return { userId: session.user.id } as OnboardingContext;
}

export async function requireOperatorContext(): Promise<OperatorContext> {
  const session = await requireSession();
  if (session.user.role !== "operator") notFound();
  return { userId: session.user.id } as OperatorContext;
}

// Contexto de quem chama a API de leitura com uma chave do SCF (#48, ADR 0006).
// É um OperatorContext (as funções de data/operator/ valem as mesmas), mais o
// ID da chave, usado no limite de requisições. `userId` é quem criou a chave.
export type OperatorKeyContext = OperatorContext & { readonly keyId: string };

// Autentica `Authorization: Bearer nrk_...`. Nulo para qualquer falha (sem
// header, formato errado, prefixo desconhecido, segredo errado, chave
// revogada ou criada por quem deixou de ser operador); quem chama responde 401
// igual em todos os casos. Só a chave de leitura vale: a de ingestão (`ntf_`)
// não passa do formato. A chave completa nunca vai para log nem para erro.
export async function authenticateReadKey(authorization: string | null): Promise<OperatorKeyContext | null> {
  const key = readKeyFromHeader(authorization);
  const parsed = key ? READ_KEY_PATTERN.exec(key) : null;
  if (!key || !parsed) return null;
  const [row] = await db
    .select({
      id: operatorApiKey.id,
      keyHash: operatorApiKey.keyHash,
      createdBy: operatorApiKey.createdBy,
      lastUsedOn: operatorApiKey.lastUsedOn,
    })
    .from(operatorApiKey)
    .innerJoin(user, eq(user.id, operatorApiKey.createdBy))
    .where(and(eq(operatorApiKey.prefix, parsed[1]!), isNull(operatorApiKey.revokedAt), eq(user.role, "operator")))
    .limit(1);
  if (!row) return null;
  const given = createHash("sha256").update(key, "utf8").digest();
  if (!timingSafeEqual(given, row.keyHash)) return null;
  // No máximo uma escrita por dia e chave.
  const today = new Date().toISOString().slice(0, 10);
  if (row.lastUsedOn !== today) {
    // Melhor esforço: falhar em gravar o último uso não pode derrubar uma
    // chave válida. O log leva só o nome do erro.
    try {
      await db
        .update(operatorApiKey)
        .set({ lastUsedOn: sql`${today}::date` })
        .where(eq(operatorApiKey.id, row.id));
    } catch (error) {
      console.error("Falha ao gravar o último uso da chave de leitura", (error as Error).name);
    }
  }
  return { userId: row.createdBy, keyId: row.id } as OperatorKeyContext;
}

// Context of someone holding an operator invite link (ADR 0017). The token in
// the link is the credential: there is no session yet. Only acceptOperatorInvite
// (src/lib/data/operator-invite.ts) takes it.
declare const operatorInviteContextBrand: unique symbol;

export type OperatorInviteContext = {
  readonly inviteId: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly [operatorInviteContextBrand]: true;
};

// 32 random bytes in base64url, as created by scripts/operator.mjs.
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Null for any failure (bad format, unknown token, already used, revoked or
// expired: a used or revoked invite no longer has a row); the page shows the same message in every case.
export async function loadOperatorInvite(token: string): Promise<OperatorInviteContext | null> {
  if (!INVITE_TOKEN_PATTERN.test(token)) return null;
  const tokenHash = createHash("sha256").update(token, "utf8").digest();
  const [row] = await db
    .select({ inviteId: operatorInvite.id, email: operatorInvite.email, expiresAt: operatorInvite.expiresAt })
    .from(operatorInvite)
    .where(
      and(
        eq(operatorInvite.tokenHash, tokenHash),
        gt(operatorInvite.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  return row ? (row as OperatorInviteContext) : null;
}
