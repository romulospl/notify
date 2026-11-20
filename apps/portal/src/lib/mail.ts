import "server-only";
import { createTransport, type Transporter } from "nodemailer";
import { env } from "./env";

// E-mail sending over SMTP (#60). Plain text only: nothing coming from the
// user becomes HTML. The links carry single-use tokens, so the message content
// never goes to a log.

let transport: Transporter | undefined;

function getTransport(): Transporter {
  transport ??= createTransport(env.smtpUrl);
  return transport;
}

export async function sendMail(message: { to: string; subject: string; text: string }): Promise<void> {
  try {
    await getTransport().sendMail({ from: env.mailFrom, ...message });
  } catch (error) {
    // No recipient or body in the log: only the error type.
    console.error("[mail] send failed:", (error as Error).name, (error as { code?: string }).code);
    throw new Error("Could not send email");
  }
}

export function verificationEmail(url: string) {
  return {
    subject: "Confirm your email for stellytics",
    text: [
      "Confirm your email address to finish creating your stellytics account:",
      "",
      url,
      "",
      "The link expires in 24 hours. If you didn't sign up, ignore this email.",
    ].join("\n"),
  };
}

export function resetPasswordEmail(url: string) {
  return {
    subject: "Reset your stellytics password",
    text: [
      "Someone asked to reset the password of your stellytics account. To choose a new one, open:",
      "",
      url,
      "",
      "The link expires in 30 minutes and works once. If it wasn't you, ignore this email;",
      "your password stays the same.",
    ].join("\n"),
  };
}
