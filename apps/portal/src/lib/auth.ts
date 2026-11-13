import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "./db";
import * as schema from "./db/schema";
import { env } from "./env";

export const auth = betterAuth({
  secret: env.authSecret,
  baseURL: env.authUrl,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    // O cadastro self-service entra na #17, com verificação de e-mail (#60).
    // Até lá, contas são criadas pelo script scripts/create-user.mjs.
    disableSignUp: true,
    minPasswordLength: 12,
  },
  user: {
    additionalFields: {
      // input: false impede que o cliente defina o papel.
      role: { type: "string", required: false, defaultValue: "tenant", input: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 dias
    updateAge: 60 * 60 * 24, // renova a cada 1 dia de uso
  },
  // Limite de tentativas por IP (em memória). O IP é usado só para isso.
  rateLimit: { enabled: true, window: 60, max: 30 },
  databaseHooks: {
    session: {
      create: {
        // Não persiste o IP de quem entra no portal.
        before: async (data) => ({ data: { ...data, ipAddress: null } }),
      },
    },
  },
  telemetry: { enabled: false },
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
