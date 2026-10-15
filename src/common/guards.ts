import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { TokenService } from '../modules/auth/token.service'
import { ENV, Env } from '../config/env'
import { KvService } from '../infra/kv'
import { ApiError, AuthedRequest, PUBLIC, RATE_LIMIT, RateLimitRule } from './http'

/** Verifies the bearer token (CPU only, no database) and exposes `req.auth`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private tokens: TokenService
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])
    const req = ctx.switchToHttp().getRequest<AuthedRequest>()
    const header = req.headers.authorization
    // Public routes never authenticate: /metrics, for one, receives the scraper's own bearer token.
    if (isPublic) return true
    if (!header?.startsWith('Bearer ')) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'unauthenticated', 'Sign in to continue')
    }
    const claims = await this.tokens.verify(header.slice(7))
    req.auth = { userId: claims.sub, sessionId: claims.sid }
    return true
  }
}

const DEFAULT_RULES: RateLimitRule[] = [
  { by: 'user', limit: 600, windowSec: 60 },
  { by: 'ip', limit: 1200, windowSec: 60 },
]

/**
 * Fixed-window counters in the shared KV (Redis in production). A route
 * adds stricter rules with @RateLimit(); the defaults protect everything.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private kvs: KvService,
    @Inject(ENV) private env: Env
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>()
    const res = ctx.switchToHttp().getResponse()
    const route = this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(RATE_LIMIT, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    const rules = route ? [...route, ...DEFAULT_RULES] : DEFAULT_RULES
    const routeKey = `${req.method}:${(req.route?.path as string | undefined) ?? req.path}`

    for (const rule of rules) {
      let subject: string | undefined
      if (rule.by === 'ip') subject = req.ip
      else if (rule.by === 'user') subject = req.auth?.userId
      else {
        const e = (req.body as { email?: unknown } | undefined)?.email
        subject = typeof e === 'string' ? e.trim().toLowerCase() : undefined
      }
      if (!subject) continue
      const scoped = rule === DEFAULT_RULES[0] || rule === DEFAULT_RULES[1] ? 'global' : routeKey
      const key = `rl:${rule.by}:${scoped}:${rule.windowSec}:${subject}`
      const n = await this.kvs.kv.incr(key, rule.windowSec)
      if (n > Math.ceil(rule.limit * this.env.rateLimitScale)) {
        res.setHeader('Retry-After', String(rule.windowSec))
        throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', 'Too many requests. Please slow down')
      }
    }
    return true
  }
}
