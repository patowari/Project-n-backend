import { Inject, Injectable, Logger } from '@nestjs/common'
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

export class PermanentMailError extends Error {}
