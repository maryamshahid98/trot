import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AppConfig } from '../config/env.ts';

export interface OutgoingMessage { to: string; subject: string; body: string }
/** One way of delivering messages on one channel. Add SMS or push by writing another of these; nothing else changes. */
export interface ChannelProvider { send(message: OutgoingMessage): Promise<{ ref?: string }> }

/** a***@example.com, or ***1234 for a phone number: enough to recognise, not enough to leak. */
export function mask(address: string): string {
  if (address.includes('@')) {
    const [name, domain] = address.split('@');
    return `${name.slice(0, 1)}***@${domain}`;
  }
  return `***${address.slice(-4)}`;
}

/** Writes a line to the log instead of sending: recipient (masked) and subject only, never the text of the message. For development. */
export class LogProvider implements ChannelProvider {
  private readonly log = new Logger('Notifications');
  constructor(private readonly channel: string) {}
  async send(m: OutgoingMessage) {
    this.log.log(`[${this.channel}] would send to ${mask(m.to)}: ${m.subject}`);
    return { ref: 'log' };
  }
}

export class SmtpProvider implements ChannelProvider {
  private readonly transport: Transporter;
  constructor(private readonly smtp: NonNullable<AppConfig['notifications']['smtp']>, private readonly from: string) {
    this.transport = nodemailer.createTransport({
      host: smtp.host, port: smtp.port, secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    });
  }
  async send(m: OutgoingMessage) {
    const info = await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.body });
    return { ref: String(info.messageId ?? '') };
  }
}

export interface Providers { email: ChannelProvider | null; sms: ChannelProvider | null }

export function buildProviders(n: AppConfig['notifications']): Providers {
  const email = n.email === 'smtp' && n.smtp && n.from ? new SmtpProvider(n.smtp, n.from) : n.email === 'log' ? new LogProvider('email') : null;
  const sms = n.sms === 'log' ? new LogProvider('sms') : null;
  return { email, sms };
}
