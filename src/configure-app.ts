import { INestApplication, ValidationError, ValidationPipe } from '@nestjs/common'
import { NestExpressApplication } from '@nestjs/platform-express'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import type { NextFunction, Response } from 'express'
import helmet from 'helmet'
import { ApiError, AuthedRequest } from './common/http'
import { accessLog, createLogger } from './common/logger'
import { requestMetaMiddleware } from './common/request-meta'
import { CamelizePipe } from './common/wire'
import { Env } from './config/env'
import { httpDuration } from './common/metrics'

export const API_PREFIX = 'api/v1'

function flatten(errors: ValidationError[], parent = ''): { field: string; message: string }[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property
    const own = Object.values(e.constraints ?? {}).map((message) => ({ field, message }))
    return [...own, ...flatten(e.children ?? [], field)]
  })
}

/** Everything that must be identical in production and in tests. */
export function configureApp(app: INestApplication, env: Env) {
  const express = app as NestExpressApplication
  if (env.trustProxy) express.set('trust proxy', 1)
  express.disable('x-powered-by')
  express.useBodyParser('json', { limit: '2mb' })

  app.use(requestMetaMiddleware)
  app.use(accessLog(createLogger(env.logLevel).http))
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }))
  app.use(compression({ threshold: 1024 }))
  app.use(cookieParser())
  app.use((req: AuthedRequest, res: Response, next: NextFunction) => {
    const end = httpDuration.startTimer()
    res.on('finish', () => {
      const route = (req.route?.path as string | undefined) ?? 'unmatched'
      end({ method: req.method, route, status: String(res.statusCode) })
    })
    next()
  })

  app.enableCors({
    origin: env.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Workspace-Id', 'X-Requested-With', 'X-Client', 'Idempotency-Key', 'If-Match', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'Idempotent-Replay', 'ETag'],
    maxAge: 600,
  })

  app.setGlobalPrefix(API_PREFIX, { exclude: ['healthz', 'readyz', 'metrics'] })
  app.useGlobalPipes(
    new CamelizePipe(),
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: (errors) =>
        new ApiError(422, 'validation_failed', 'One or more fields are invalid', flatten(errors)),
    })
  )
  app.enableShutdownHooks()
}
