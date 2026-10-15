import { CallHandler, ExecutionContext, HttpStatus, Injectable, NestInterceptor } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { from, lastValueFrom, Observable } from 'rxjs'
import { Caller, Role, RoleGrant, rolesOf } from '../authz/caller'
import { Db } from '../infra/db'
import {
  ALLOW_UNVERIFIED,
  ApiError,
  AuthedRequest,
  IDEMPOTENT,
  isUuid,
  NO_WORKSPACE,
  PLATFORM_ADMIN,
  PUBLIC,
  ROLES,
} from './http'
import { sha256 } from './crypto'

/**
 * One database transaction per request:
 *
 *   BEGIN
 *   set_config('app.workspace_id' / 'app.user_id', ..., local)   <- RLS context
 *   load caller (user, membership, role grants)                    <- authorization input
 *   check roles / e-mail verification / idempotency key
 *   run the handler                                                <- all writes + job enqueue
 *   COMMIT                                                         <- before the response is sent
 *
 * Domain changes, activity log entries and queued jobs therefore commit or
 * roll back together (transactional outbox).
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    private reflector: Reflector,
    private db: Db
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const get = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()])
    const req = ctx.switchToHttp().getRequest<AuthedRequest>()
    const res = ctx.switchToHttp().getResponse()

    if (get<boolean>(PUBLIC) && !req.auth) return next.handle()
    if (!req.auth) throw new ApiError(HttpStatus.UNAUTHORIZED, 'unauthenticated', 'Sign in to continue')

    const noWorkspace = !!get<boolean>(NO_WORKSPACE)
    const platformOnly = !!get<boolean>(PLATFORM_ADMIN)
    const roles = get<Role[] | undefined>(ROLES)
    const allowUnverified = !!get<boolean>(ALLOW_UNVERIFIED)
    const idempotent = !!get<boolean>(IDEMPOTENT)

    const header = req.headers['x-workspace-id']
    const wsId = Array.isArray(header) ? header[0] : header
    if (wsId !== undefined && !isUuid(wsId)) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_workspace', 'X-Workspace-Id must be a UUID')
    }
    if (!noWorkspace && !platformOnly && !wsId) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'workspace_required', 'Send the X-Workspace-Id header')
    }
    const workspaceId = platformOnly ? null : (wsId ?? null)
    const userId = req.auth.userId

    return from(
      this.db.run({ userId, workspaceId }, async () => {
        const caller = await this.loadCaller(req, workspaceId)
        req.caller = caller

        if (platformOnly && !caller.isPlatformAdmin) {
          throw new ApiError(HttpStatus.FORBIDDEN, 'forbidden', 'Platform administrators only')
        }
        if (roles && roles.length > 0) {
          const have = rolesOf(caller)
          if (!roles.some((r) => have.has(r))) {
            throw new ApiError(HttpStatus.FORBIDDEN, 'forbidden', 'Your role cannot do this')
          }
        }
        const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
        if (isWrite && !caller.emailVerified && !allowUnverified) {
          throw new ApiError(HttpStatus.FORBIDDEN, 'email_not_verified', 'Verify your e-mail address first')
        }

        const key = idempotent ? req.headers['idempotency-key'] : undefined
        if (key !== undefined) {
          const k = Array.isArray(key) ? key[0] : key
          if (!k || k.length > 200) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_idempotency_key', 'Idempotency-Key is invalid')
          const replay = await this.claimKey(req, k)
          if (replay) {
            res.status(replay.status)
            res.setHeader('Idempotent-Replay', 'true')
            return replay.body
          }
          const body = await lastValueFrom(next.handle())
          await this.storeResult(req, k, res.statusCode, body)
          return body
        }
        return lastValueFrom(next.handle())
      })
    )
  }

  /**
   * Who is calling, in ONE statement (user + membership + role grants + workspace state).
   * This runs on every request, so it is raw SQL: the ORM needed five statements here.
   * RLS still applies: the rows come back only if the policies let this user see them.
   */
  private async loadCaller(req: AuthedRequest, workspaceId: string | null): Promise<Caller> {
    const { userId, sessionId } = req.auth!
    const rows = await this.db.tx.$queryRaw<
      {
        name: string
        email: string
        email_verified: boolean
        is_platform_admin: boolean
        user_status: string
        membership_id: string | null
        can_approve: boolean | null
        ws_type: 'institution' | 'supervision' | null
        ws_status: 'pending_approval' | 'active' | 'suspended' | null
        grants: { role: RoleGrant['role']; scope_type: RoleGrant['scopeType']; scope_id: string | null }[]
      }[]
    >`
      SELECT u.name, u.email, (u.email_verified_at IS NOT NULL) AS email_verified, u.is_platform_admin, u.status::text AS user_status,
             m.id AS membership_id, m.can_approve, w.type::text AS ws_type, w.status::text AS ws_status,
             COALESCE((SELECT json_agg(json_build_object('role', r.role, 'scope_type', r.scope_type, 'scope_id', r.scope_id))
                       FROM membership_roles r WHERE r.membership_id = m.id), '[]'::json) AS grants
      FROM users u
      LEFT JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ${workspaceId}::uuid AND m.status = 'active'
      LEFT JOIN workspaces w ON w.id = m.workspace_id
      WHERE u.id = ${userId}::uuid`
    const u = rows[0]
    if (!u || u.user_status !== 'active') {
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'unauthenticated', 'This account is not active')
    }
    const caller: Caller = {
      userId,
      sessionId,
      name: u.name,
      email: u.email,
      emailVerified: u.email_verified,
      isPlatformAdmin: u.is_platform_admin,
      workspaceId: null,
      workspaceType: null,
      workspaceStatus: null,
      membershipId: null,
      canApprove: false,
      grants: [],
    }
    if (!workspaceId) return caller
    if (!u.membership_id) {
      // Not a member (or not visible): indistinguishable from "no such workspace".
      throw new ApiError(HttpStatus.FORBIDDEN, 'not_a_member', 'You are not a member of this workspace')
    }
    if (u.ws_status !== 'active') {
      throw new ApiError(HttpStatus.FORBIDDEN, `workspace_${u.ws_status}`, 'This workspace is not active')
    }
    caller.workspaceId = workspaceId
    caller.workspaceType = u.ws_type
    caller.workspaceStatus = u.ws_status
    caller.membershipId = u.membership_id
    caller.canApprove = !!u.can_approve
    caller.grants = u.grants.map((g) => ({ role: g.role, scopeType: g.scope_type, scopeId: g.scope_id }))
    return caller
  }

  /**
   * Insert-or-replay inside the request transaction. A concurrent request with
   * the same key blocks on the unique index until this one commits, then
   * replays the stored result; if this one rolls back, the key disappears.
   */
  private async claimKey(req: AuthedRequest, key: string): Promise<{ status: number; body: unknown } | null> {
    const hash = sha256(`${req.method} ${req.path} ${JSON.stringify(req.body ?? {})}`)
    const tx = this.db.tx
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, expires_at)
      VALUES (${req.auth!.userId}::uuid, ${key}, ${req.method}, ${req.path}, ${hash}, now() + interval '24 hours')
      ON CONFLICT (user_id, key, method, path) DO NOTHING
      RETURNING id`
    if (inserted.length > 0) return null
    const row = await tx.idempotencyKey.findFirst({
      where: { userId: req.auth!.userId, key, method: req.method, path: req.path },
    })
    if (!row) return null
    if (row.requestHash !== hash) {
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'idempotency_key_reuse',
        'This Idempotency-Key was already used with a different request'
      )
    }
    return { status: row.responseStatus ?? 200, body: row.responseBody }
  }

  private async storeResult(req: AuthedRequest, key: string, status: number, body: unknown) {
    await this.db.tx.idempotencyKey.updateMany({
      where: { userId: req.auth!.userId, key, method: req.method, path: req.path },
      data: {
        state: 'completed',
        responseStatus: status,
        // JSON round-trip drops Dates/BigInt in a stable way for replay
        responseBody: JSON.parse(JSON.stringify(body ?? null, (_, v) => (typeof v === 'bigint' ? Number(v) : v))),
      },
    })
  }
}
