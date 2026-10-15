import {
  BadRequestException,
  ConflictException,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import { Caller, Role } from '../authz/caller'

/* ---------- request shape ---------- */

export interface AuthedRequest extends Request {
  id: string
  auth?: { userId: string; sessionId: string }
  caller?: Caller
}

/* ---------- route metadata ---------- */

export const PUBLIC = 'public'
export const ROLES = 'roles'
export const ALLOW_UNVERIFIED = 'allowUnverified'
export const NO_WORKSPACE = 'noWorkspace'
export const PLATFORM_ADMIN = 'platformAdmin'
export const RATE_LIMIT = 'rateLimit'
export const IDEMPOTENT = 'idempotent'

/** No bearer token needed. */
export const Public = () => SetMetadata(PUBLIC, true)
/** Any-of workspace roles (or `super_admin`). Omit for "any member". */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles)
/** Allow users who have not verified their e-mail yet (reads are always allowed). */
export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED, true)
/** Authenticated but not tied to one workspace (/me, workspace switcher). */
export const NoWorkspace = () => SetMetadata(NO_WORKSPACE, true)
/** Super Admin only; no workspace context, content tables are out of reach. */
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN, true)
/** Honour the `Idempotency-Key` header: same key + same body = same result. */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true)

export interface RateLimitRule {
  /** What the counter is keyed on. `body.email` limits per target account. */
  by: 'ip' | 'user' | 'body.email'
  limit: number
  windowSec: number
}
export const RateLimit = (...rules: RateLimitRule[]) => SetMetadata(RATE_LIMIT, rules)

export const CurrentCaller = createParamDecorator((_: unknown, ctx: ExecutionContext): Caller => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>()
  if (!req.caller) throw new UnauthorizedException()
  return req.caller
})

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>()
  if (!req.auth) throw new UnauthorizedException()
  return req.auth
})

/* ---------- problem+json errors (RFC 9457) ---------- */

export interface ProblemBody {
  type: string
  title: string
  status: number
  detail?: string
  code: string
  errors?: { field?: string; message: string }[]
  request_id?: string
}

/** Domain error carrying a stable machine-readable `code` for clients. */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    detail?: string,
    readonly errors?: { field?: string; message: string }[]
  ) {
    super({ code, detail, errors }, status)
  }
}

export const notFound = (what = 'Resource') => new ApiError(HttpStatus.NOT_FOUND, 'not_found', `${what} not found`)
export const forbidden = (code = 'forbidden', detail = 'You do not have permission to do this') =>
  new ApiError(HttpStatus.FORBIDDEN, code, detail)
export const conflict = (code: string, detail: string) => new ApiError(HttpStatus.CONFLICT, code, detail)
export const unprocessable = (code: string, detail: string, errors?: { field?: string; message: string }[]) =>
  new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, code, detail, errors)
export const badRequest = (code: string, detail: string) => new ApiError(HttpStatus.BAD_REQUEST, code, detail)

export { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException }

/* ---------- cursor pagination ---------- */

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export const MAX_LIMIT = 100

export function clampLimit(raw: unknown, def = 50): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), MAX_LIMIT)
}

export interface KeysetCursor {
  t: string
  id: string
}
export const encodeCursor = (c: KeysetCursor) => Buffer.from(JSON.stringify(c)).toString('base64url')
export function decodeCursor(raw?: string | null): KeysetCursor | null {
  if (!raw) return null
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as KeysetCursor
    if (typeof c.t === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.t))) return c
  } catch {
    /* fall through */
  }
  throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_cursor', 'The pagination cursor is not valid')
}

/** Fetch limit+1 rows, trim, and build the next cursor from the last kept row. */
export function toPage<T extends { id: string }>(rows: T[], limit: number, at: (row: T) => Date): Page<T> {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  return { items, nextCursor: hasMore && last ? encodeCursor({ t: at(last).toISOString(), id: last.id }) : null }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s)
