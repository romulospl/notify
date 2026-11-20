import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { db } from "./db";
import * as schema from "./db/schema";
import { env } from "./env";
import { resetPasswordEmail, sendMail, verificationEmail } from "./mail";

export const auth = betterAuth({
  secret: env.authSecret,
  baseURL: env.authUrl,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    // Open sign-up (#60): the account can only sign in after confirming the
    // e-mail, so it creates no project before that. With this option, a
    // sign-up with an e-mail that already exists gets the same response as a
    // new sign-up, without revealing who has an account.
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await sendMail({ to: user.email, ...resetPasswordEmail(url) });
    },
    // The reset link is valid for 30 minutes and only once.
    resetPasswordTokenExpiresIn: 60 * 30,
    // Resetting the password ends the other sessions.
    revokeSessionsOnPasswordReset: true,
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail({ to: user.email, ...verificationEmail(url) });
    },
    sendOnSignUp: true,
    // Whoever tries to sign in without having confirmed gets another link.
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
  },
  user: {
    additionalFields: {
      // input: false prevents the client from setting the role.
      role: { type: "string", required: false, defaultValue: "tenant", input: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // renews after each 1 day of use
  },
  // Attempt limit per IP (in memory, per instance). The IP is used only for
  // this. Better Auth already limits sign-in to 3 requests every 10 seconds.
  // For sign-up and requests that send e-mail, the rules below replace the
  // default limit with a tighter, per-hour limit (#60).
  rateLimit: {
    enabled: true,
    window: 60,
    max: 30,
    customRules: {
      "/sign-up/email": { window: 60 * 60, max: 10 },
      "/request-password-reset": { window: 60 * 60, max: 5 },
      "/send-verification-email": { window: 60 * 60, max: 5 },
    },
  },
  // "warn" is the default; it is explicit because the "info" level logs the
  // e-mail of whoever tries to sign up again.
  logger: { level: "warn" },
  databaseHooks: {
    session: {
      create: {
        // Does not persist the IP of whoever signs in to the portal.
        before: async (data) => ({ data: { ...data, ipAddress: null } }),
      },
    },
  },
  telemetry: { enabled: false },
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
