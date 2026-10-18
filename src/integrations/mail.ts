import { Inject, Injectable, Logger } from '@nestjs/common'
import { createTransport, type Transporter } from 'nodemailer'
import { ENV, Env } from '../config/env'

export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  /** Same key = at most one delivery, even if the job runs twice. */
  idempotencyKey: string
  attachments?: { filename: string; content: string }[]
}

export abstract class MailerPort {
  abstract send(m: MailMessage): Promise<void>
}

/** Development and tests: record instead of sending. */
@Injectable()
export class LogMailer extends MailerPort {
  private readonly log = new Logger('Mail')
  readonly outbox: MailMessage[] = []
  /** Test hook: make the next send fail. */
  failNext: Error | null = null
  async send(m: MailMessage) {
    if (this.failNext) {
      const e = this.failNext
      this.failNext = null
      throw e
    }
    this.outbox.push(m)
    if (this.outbox.length > 500) this.outbox.shift()
    this.log.debug(`to=${m.to} subject="${m.subject}"`)
  }
}

/** Resend (https://resend.com). The idempotency key makes retried jobs safe. */
@Injectable()
export class ResendMailer extends MailerPort {
  constructor(@Inject(ENV) private env: Env) {
    super()
  }
  async send(m: MailMessage) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.env.resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': m.idempotencyKey },
      body: JSON.stringify({ from: this.env.emailFrom, to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(m.attachments ? { attachments: m.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) } : {}) }),
    })
    if (res.status === 429 || res.status >= 500) throw new Error(`resend ${res.status}`) // retry
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 4xx other than rate limits are permanent: do not retry forever
      throw new PermanentMailError(`resend ${res.status}: ${body.slice(0, 200)}`)
    }
  }
}

/**
 * Plain SMTP (for example the mail server on the same VPS). Always upgrades to
 * TLS. SMTP cannot de-duplicate, so a retried job may deliver twice in the rare
 * case the server accepted the message but the acknowledgement was lost; the
 * Message-ID is derived from the idempotency key so receivers can spot it.
 */
@Injectable()
export class SmtpMailer extends MailerPort {
  private transport: Transporter | null = null
  constructor(@Inject(ENV) private env: Env) {
    super()
  }
  private transporter(): Transporter {
    const { host, port, user, pass, secure, rejectUnauthorized } = this.env.smtp
    this.transport ??= createTransport({
      host: host!,
      port,
      secure,
      requireTLS: !secure,
      auth: { user: user!, pass: pass! },
      tls: { rejectUnauthorized },
      pool: true,
      maxConnections: 3,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    })
    return this.transport
  }
  async send(m: MailMessage) {
    const domain = /@([^>\s]+)>?\s*$/.exec(this.env.emailFrom)?.[1] ?? 'localhost'
    try {
      await this.transporter().sendMail({
        from: this.env.emailFrom,
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        messageId: `<${m.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '-')}@${domain}>`,
        ...(m.attachments ? { attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content })) } : {}),
      })
    } catch (e) {
      const code = (e as { responseCode?: number }).responseCode
      // 5xx replies (bad mailbox, policy rejection) will not succeed on retry; everything else (4xx, network, TLS) will
      if (code && code >= 500 && code < 600) throw new PermanentMailError(`smtp ${code}: ${String((e as Error).message).slice(0, 200)}`)
      throw e
    }
  }
}

export class PermanentMailError extends Error {}
