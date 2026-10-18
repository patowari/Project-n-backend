import { Provider } from '@nestjs/common'
import { ENV, Env } from '../config/env'
import { AiPort, DocTools, FakeAi, GeminiAi } from '../integrations/ai'
import { LogMailer, MailerPort, ResendMailer, SmtpMailer } from '../integrations/mail'
import { HealthService } from '../modules/workflow/health.service'
import { Handlers } from './handlers'
import { JobRunner } from './runner'

/**
 * Everything the job runner needs. The API registers these too, so the free
 * demo can run the loop in-process (INLINE_WORKER=true); in production the
 * same code runs as its own deployable (`node dist/worker.js`).
 */
export const WORKER_PROVIDERS: Provider[] = [
  LogMailer,
  ResendMailer,
  SmtpMailer,
  FakeAi,
  GeminiAi,
  DocTools,
  HealthService,
  Handlers,
  JobRunner,
  {
    provide: MailerPort,
    inject: [ENV, LogMailer, ResendMailer, SmtpMailer],
    useFactory: (env: Env, log: LogMailer, resend: ResendMailer, smtp: SmtpMailer): MailerPort => (env.mailDriver === 'resend' ? resend : env.mailDriver === 'smtp' ? smtp : log),
  },
  { provide: AiPort, inject: [ENV, FakeAi, GeminiAi], useFactory: (env: Env, fake: FakeAi, gemini: GeminiAi): AiPort => (env.aiDriver === 'gemini' ? gemini : fake) },
]
