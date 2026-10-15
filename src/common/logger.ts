import { LoggerService } from '@nestjs/common'
import type { NextFunction, Response } from 'express'
import pino, { Logger } from 'pino'
import { AuthedRequest } from './http'
import { requestMeta } from './request-meta'

/**
 * Structured JSON logs (one object per line) for every Nest log call and one
 * access-log line per request, all carrying request_id, user_id and
 * workspace_id so a single request can be followed across API and worker logs.
 * Secrets are redacted by path; request bodies are never logged.
 */
export function createLogger(level: string): { app: LoggerService; http: Logger } {
  const base = pino({
    level,
    base: { service: process.env.SERVICE_NAME ?? 'projectn-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.refresh_token', '*.refreshToken'], censor: '[redacted]' },
    mixin: () => ({ request_id: requestMeta().requestId }),
  })
  const ctx = (c?: string) => (c ? { context: c } : {})
  const app: LoggerService = {
    log: (m: unknown, c?: string) => base.info({ ...ctx(c) }, String(m)),
    error: (m: unknown, trace?: string, c?: string) => base.error({ ...ctx(c), ...(trace ? { stack: trace } : {}) }, String(m)),
    warn: (m: unknown, c?: string) => base.warn({ ...ctx(c) }, String(m)),
    debug: (m: unknown, c?: string) => base.debug({ ...ctx(c) }, String(m)),
    verbose: (m: unknown, c?: string) => base.trace({ ...ctx(c) }, String(m)),
  }
  return { app, http: base }
}

export function accessLog(http: Logger) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint()
    res.on('finish', () => {
      if (req.path === '/healthz' || req.path === '/readyz') return
      const ms = Number(process.hrtime.bigint() - start) / 1e6
      const status = res.statusCode
      http[status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'](
        {
          type: 'http',
          method: req.method,
          route: (req.route?.path as string | undefined) ?? req.path,
          status,
          duration_ms: Math.round(ms * 10) / 10,
          user_id: req.auth?.userId,
          workspace_id: req.caller?.workspaceId ?? undefined,
          ip: req.ip,
          bytes: Number(res.getHeader('content-length') ?? 0),
        },
        'request'
      )
    })
    next()
  }
}
