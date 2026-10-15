import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { NextFunction, Response } from 'express'
import type { AuthedRequest } from './http'

export interface RequestMeta {
  requestId: string
  ip: string | null
  userAgent: string | null
}

const store = new AsyncLocalStorage<RequestMeta>()

export const requestMeta = (): RequestMeta => store.getStore() ?? { requestId: 'none', ip: null, userAgent: null }

/** Assigns a request id (honouring an inbound one) and keeps ip / UA for audit rows. */
export function requestMetaMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const inbound = req.headers['x-request-id']
  const id = typeof inbound === 'string' && /^[\w.-]{8,64}$/.test(inbound) ? inbound : randomUUID()
  req.id = id
  res.setHeader('X-Request-Id', id)
  store.run({ requestId: id, ip: req.ip ?? null, userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) || null }, next)
}
