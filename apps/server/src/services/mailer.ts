import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** Resolves true when handed to an SMTP server, false when SMTP is not configured (logged instead). */
  send(mail: Mail): Promise<boolean>;
}

export function createMailer(config: Config, log: (msg: string) => void = console.log): Mailer {
  let transport: Transporter | undefined;
  if (config.SMTP_HOST) {
    transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    });
  }
  return {
    async send(mail) {
      if (!transport) {
        // Development fallback so flows stay testable without an SMTP server. Never in production logs of secrets
        // beyond what the user would receive anyway.
        if (!config.isProd) log(`[mail:not-sent] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
        return false;
      }
      await transport.sendMail({ from: config.SMTP_FROM, ...mail });
      return true;
    },
  };
}
