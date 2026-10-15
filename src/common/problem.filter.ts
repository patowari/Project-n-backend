import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { Response } from 'express'
import { RowNotVisible } from '../infra/db'
import { ApiError, AuthedRequest, ProblemBody } from './http'

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  412: 'Precondition failed',
  413: 'Payload too large',
  422: 'Unprocessable entity',
  429: 'Too many requests',
  500: 'Internal server error',
  503: 'Service unavailable',
}

/** Postgres SQLSTATE -> HTTP, for errors raised by constraints, RLS and triggers. */
function fromPgCode(code: string | undefined): { status: number; code: string; detail: string } | null {
  switch (code) {
    case '23505':
      return { status: 409, code: 'already_exists', detail: 'A record with the same unique value already exists' }
    case '23503':
      return { status: 409, code: 'invalid_reference', detail: 'The record refers to something that does not exist or belongs to another workspace' }
    case '23514':
      return { status: 409, code: 'invalid_state', detail: 'The change is not allowed in the current state' }
    case '42501':
      return { status: 403, code: 'forbidden', detail: 'The database refused this operation for your role' }
    case '40P01':
    case '40001':
      return { status: 409, code: 'concurrent_update', detail: 'The record was changed by someone else. Please retry' }
    default:
      return null
  }
}

/** RFC 9457 problem details for every error (architecture 12). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors')

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp()
    const res = http.getResponse<Response>()
    const req = http.getRequest<AuthedRequest>()

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR
    let code = 'internal_error'
    let detail: string | undefined
    let errors: ProblemBody['errors']
    let retryAfter: number | undefined

    if (exception instanceof ApiError) {
      status = exception.getStatus()
      const body = exception.getResponse() as { code: string; detail?: string; errors?: ProblemBody['errors'] }
      code = body.code
      detail = body.detail
      errors = body.errors
    } else if (exception instanceof RowNotVisible) {
      status = 404
      code = 'not_found'
      detail = 'Resource not found'
    } else if (exception instanceof HttpException) {
      status = exception.getStatus()
      const body = exception.getResponse() as string | { message?: string | string[]; error?: string; code?: string; retryAfter?: number }
      if (typeof body === 'string') detail = body
      else {
        code = body.code ?? (status === 400 && Array.isArray(body.message) ? 'validation_failed' : (body.error ?? 'error').toLowerCase().replace(/\s+/g, '_'))
        retryAfter = body.retryAfter
        if (Array.isArray(body.message)) {
          errors = body.message.map((m) => ({ message: m, field: m.split(' ')[0] }))
          detail = 'One or more fields are invalid'
        } else detail = body.message
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const pg = fromPgCode((exception.meta as { code?: string } | undefined)?.code)
      if (exception.code === 'P2002') ({ status, code, detail } = { status: 409, code: 'already_exists', detail: 'A record with the same unique value already exists' })
      else if (exception.code === 'P2025') ({ status, code, detail } = { status: 404, code: 'not_found', detail: 'Resource not found' })
      else if (exception.code === 'P2003') ({ status, code, detail } = { status: 409, code: 'invalid_reference', detail: 'The record refers to something that does not exist or belongs to another workspace' })
      else if (pg) ({ status, code, detail } = pg)
      else this.log.error(`prisma ${exception.code}: ${exception.message}`)
    } else {
      const pg = fromPgCode((exception as { code?: string })?.code)
      if (pg) ({ status, code, detail } = pg)
      else this.log.error(exception instanceof Error ? exception.stack : String(exception))
    }

    if (status >= 500) detail = undefined // never leak internals
    const body: ProblemBody = {
      type: `https://projectn.app/problems/${code}`,
      title: TITLES[status] ?? 'Error',
      status,
      code,
      ...(detail ? { detail } : {}),
      ...(errors ? { errors } : {}),
      ...(req.id ? { request_id: req.id } : {}),
    }
    if (retryAfter) res.setHeader('Retry-After', String(retryAfter))
    res.status(status).type('application/problem+json').json(body)
  }
}
