import { HttpStatus, Inject, Injectable } from '@nestjs/common'
import { Prisma, WorkspaceType } from '@prisma/client'
import { ApiError, unprocessable } from '../../common/http'
import { randomToken, sha256 } from '../../common/crypto'
import { requestMeta } from '../../common/request-meta'
import { ENV, Env } from '../../config/env'
import { Db } from '../../infra/db'
import { KvService } from '../../infra/kv'
import { AuditService, JobsService } from '../core/core.services'
import { MeService, MeView } from './me.view'
import { assertAcceptablePassword, PasswordService } from './password'
import { TokenService } from './token.service'

const VERIFY_TTL_MS = 24 * 3600 * 1000
const RESET_TTL_MS = 30 * 60 * 1000
const LOCK_AFTER_FAILURES = 10
const LOCK_WINDOW_SEC = 15 * 60
/** A second refresh with the same token this soon is a multi-tab race, not theft. */
const REFRESH_GRACE_MS = 10_000

export interface AuthResult {
  accessToken: string
  refreshToken: string
  user: MeView
}

export function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /okhttp|ReactNative|Expo/i.test(ua) ? 'Mobile app' : /Tauri/i.test(ua) ? 'Desktop app' : 'Browser'
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} on ${os}` : browser
}

@Injectable()
export class AuthService {
  constructor(
    private db: Db,
    private pw: PasswordService,
    private tokens: TokenService,
    private me: MeService,
    private jobs: JobsService,
    private audit: AuditService,
    private kvs: KvService,
    @Inject(ENV) private env: Env
  ) {}

  /* ---------------------------- sign-up ---------------------------- */

  /**
   * Same answer whether or not the e-mail exists, so the endpoint cannot be
   * used to discover accounts. Existing owners get an "account exists" mail.
   */
  async signUp(input: { name: string; email: string; password: string; workspaceType: WorkspaceType; workspaceName: string }) {
    const email = input.email.trim().toLowerCase()
    assertAcceptablePassword(input.password, { email, name: input.name })
    const passwordHash = await this.pw.hash(input.password)
    const status = input.workspaceType === 'supervision' ? ('active' as const) : ('pending_approval' as const)

    await this.db.asAuth(async () => {
      const tx = this.db.tx
      const existing = await tx.user.findUnique({ where: { email }, select: { id: true, name: true } })
      if (existing) {
        await this.jobs.email(email, 'account_exists', { name: existing.name })
        await this.audit.log('auth.signup_existing_email', { targetType: 'user', targetId: existing.id })
        return
      }
      const user = await tx.user.create({
        data: { email, name: input.name, passwordHash, passwordChangedAt: new Date() },
      })
      await this.db.setUser(user.id)
      const workspace = await this.createOwnerWorkspace(user.id, input.workspaceType, input.workspaceName, status)
      await this.issueVerification(user.id, email, user.name)
      await this.audit.log('auth.signup', { actorId: user.id, workspaceId: workspace.id, targetType: 'workspace', targetId: workspace.id })
    })
    return { workspaceStatus: status }
  }

  /**
   * Creates a workspace with `userId` as its owner (Supervision Owner + Supervisor, or Institution Admin).
   * Call inside `db.asAuth` after `db.setUser(userId)`; shared by e-mail and Google sign-up.
   */
  async createOwnerWorkspace(userId: string, type: WorkspaceType, name: string, status: 'active' | 'pending_approval') {
    const tx = this.db.tx
    const workspace = await tx.workspace.create({
      data: {
        name,
        shortName: name.slice(0, 24),
        type,
        status,
      },
    })
    await this.db.setWorkspace(workspace.id)
    const roles = type === 'supervision' ? (['supervision_owner', 'supervisor'] as const) : (['institution_admin'] as const)
    const membership = await tx.membership.create({
      data: { workspaceId: workspace.id, userId, canApprove: type === 'supervision' },
    })
    await tx.membershipRole.createMany({
      data: roles.map((role) => ({ workspaceId: workspace.id, membershipId: membership.id, role })),
    })
    // Only after the membership exists does the workspace become visible to its owner (RLS: pn_ws()).
    await tx.workspaceSettings.create({ data: { workspaceId: workspace.id } })
    await tx.user.update({ where: { id: userId }, data: { defaultWorkspaceId: workspace.id } })
    return workspace
  }

  /* ----------------------------- login ----------------------------- */

  async login(email: string, password: string): Promise<AuthResult> {
    const addr = email.trim().toLowerCase()
    const user = await this.db.asAuth(() =>
      this.db.tx.user.findUnique({
        where: { email: addr },
        select: { id: true, name: true, passwordHash: true, status: true, lockedUntil: true },
      })
    )
    const bad = () => new ApiError(HttpStatus.UNAUTHORIZED, 'invalid_credentials', 'E-mail or password is incorrect')

    if (!user?.passwordHash || user.status !== 'active') {
      await this.pw.verifyDummy(password)
      throw bad()
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.pw.verifyDummy(password)
      throw new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'account_locked', 'Too many failed attempts. Try again in a few minutes')
    }

    const ok = await this.pw.verify(user.passwordHash, password)
    if (!ok) {
      await this.recordFailure(user.id, addr, user.name)
      throw bad()
    }

    return this.db.asAuth(async () => {
      const tx = this.db.tx
      await this.kvs.kv.del(`login:fail:${user.id}`)
      const data: Prisma.UserUpdateInput = { lockedUntil: null, failedLoginCount: 0 }
      if (this.pw.needsRehash(user.passwordHash!)) data.passwordHash = await this.pw.hash(password)
      await tx.user.update({ where: { id: user.id }, data })
      const { sessionId, refreshToken } = await this.createSession(user.id)
      await this.db.setUser(user.id)
      const me = await this.me.build(user.id)
      await this.audit.log('auth.login', { actorId: user.id, targetType: 'session', targetId: sessionId })
      return { accessToken: this.tokens.sign(user.id, sessionId), refreshToken, user: me }
    })
  }

  private async recordFailure(userId: string, email: string, name: string) {
    const n = await this.kvs.kv.incr(`login:fail:${userId}`, LOCK_WINDOW_SEC)
    if (n < LOCK_AFTER_FAILURES) return
    await this.kvs.kv.del(`login:fail:${userId}`)
    await this.db.asAuth(async () => {
      await this.db.tx.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + LOCK_WINDOW_SEC * 1000) },
      })
      await this.jobs.email(email, 'account_locked', { name })
      await this.audit.log('auth.locked', { actorId: userId, targetType: 'user', targetId: userId })
    })
  }

  async createSession(userId: string) {
    const m = requestMeta()
    const session = await this.db.tx.session.create({
      data: { userId, deviceLabel: deviceLabel(m.userAgent), ip: m.ip, userAgent: m.userAgent },
    })
    const refreshToken = randomToken()
    await this.db.tx.refreshToken.create({
      data: {
        sessionId: session.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + this.env.refreshTokenTtlSec * 1000),
      },
    })
    return { sessionId: session.id, refreshToken }
  }

  /** Used by invite acceptance, which signs the new user straight in. */
  async startSession(userId: string): Promise<AuthResult> {
    return this.db.asAuth(async () => {
      const { sessionId, refreshToken } = await this.createSession(userId)
      await this.db.setUser(userId)
      return { accessToken: this.tokens.sign(userId, sessionId), refreshToken, user: await this.me.build(userId) }
    })
  }

  /* ---------------------------- refresh ---------------------------- */

  /**
   * Rotation with reuse detection. Exactly one request wins the atomic
   * `used_at IS NULL` update; a second presentation of the same token later
   * than the grace window means the token leaked, so the whole session dies.
   */
  async refresh(rawToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const hash = sha256(rawToken)
    const outcome = await this.db.asAuth(async () => {
      const tx = this.db.tx
      const rt = await tx.refreshToken.findUnique({ where: { tokenHash: hash }, include: { session: true } })
      if (!rt) return { kind: 'invalid' as const }
      if (rt.session.revokedAt || rt.expiresAt < new Date()) return { kind: 'invalid' as const }

      const claimed = await tx.refreshToken.updateMany({ where: { id: rt.id, usedAt: null }, data: { usedAt: new Date() } })
      if (claimed.count === 0) {
        const age = Date.now() - (rt.usedAt?.getTime() ?? 0)
        if (age < REFRESH_GRACE_MS) return { kind: 'in_flight' as const }
        await tx.session.update({ where: { id: rt.sessionId }, data: { revokedAt: new Date(), revokedReason: 'refresh_reuse' } })
        await this.audit.log('auth.refresh_reuse_detected', { actorId: rt.session.userId, targetType: 'session', targetId: rt.sessionId })
        return { kind: 'reuse' as const, sessionId: rt.sessionId }
      }

      const user = await tx.user.findUnique({ where: { id: rt.session.userId }, select: { status: true } })
      if (!user || user.status !== 'active') return { kind: 'invalid' as const }

      const next = randomToken()
      const created = await tx.refreshToken.create({
        data: {
          sessionId: rt.sessionId,
          tokenHash: sha256(next),
          expiresAt: new Date(Date.now() + this.env.refreshTokenTtlSec * 1000),
        },
      })
      await tx.refreshToken.update({ where: { id: rt.id }, data: { replacedById: created.id } })
      await tx.session.update({ where: { id: rt.sessionId }, data: { lastSeenAt: new Date() } })
      return { kind: 'ok' as const, userId: rt.session.userId, sessionId: rt.sessionId, refreshToken: next }
    })

    switch (outcome.kind) {
      case 'ok':
        return { accessToken: this.tokens.sign(outcome.userId, outcome.sessionId), refreshToken: outcome.refreshToken }
      case 'reuse':
        await this.tokens.markRevoked([outcome.sessionId])
        throw new ApiError(HttpStatus.UNAUTHORIZED, 'refresh_reuse_detected', 'This session was signed out for your safety. Sign in again')
      case 'in_flight':
        throw new ApiError(HttpStatus.CONFLICT, 'refresh_in_flight', 'A refresh for this token is already in progress. Retry')
      default:
        throw new ApiError(HttpStatus.UNAUTHORIZED, 'invalid_refresh_token', 'Sign in again')
    }
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return
    const sessionId = await this.db.asAuth(async () => {
      const rt = await this.db.tx.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) }, select: { sessionId: true } })
      if (!rt) return null
      await this.db.tx.session.updateMany({ where: { id: rt.sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'logout' } })
      return rt.sessionId
    })
    if (sessionId) await this.tokens.markRevoked([sessionId])
  }

  /* ------------------ verification, forgot, reset ------------------ */

  /** Issues a new token and invalidates older ones. Call inside a transaction. */
  async issueVerification(userId: string, email: string, name: string) {
    const tx = this.db.tx
    await tx.authToken.updateMany({ where: { userId, kind: 'verify_email', usedAt: null }, data: { usedAt: new Date() } })
    const token = randomToken()
    await tx.authToken.create({
      data: { userId, kind: 'verify_email', tokenHash: sha256(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) },
    })
    await this.jobs.email(email, 'verify_email', { name, link: `${this.env.appBaseUrl}/verify-email?token=${token}` })
  }

  async resendVerification(userId: string) {
    const u = await this.db.tx.user.findUniqueOrThrow({ where: { id: userId } })
    if (u.emailVerifiedAt) return
    await this.issueVerification(u.id, u.email, u.name)
  }

  async verifyEmail(token: string) {
    await this.db.asAuth(async () => {
      const tx = this.db.tx
      const t = await tx.authToken.findUnique({ where: { tokenHash: sha256(token) } })
      if (!t || t.kind !== 'verify_email' || t.usedAt || t.expiresAt < new Date()) {
        throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_token', 'This link is invalid or has expired')
      }
      const claimed = await tx.authToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } })
      if (claimed.count === 0) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_token', 'This link is invalid or has expired')
      await tx.user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } })
      await this.audit.log('auth.email_verified', { actorId: t.userId, targetType: 'user', targetId: t.userId })
    })
  }

  /** Always succeeds from the caller's point of view (no account discovery). */
  async forgotPassword(email: string) {
    const addr = email.trim().toLowerCase()
    await this.db.asAuth(async () => {
      const tx = this.db.tx
      const u = await tx.user.findUnique({ where: { email: addr }, select: { id: true, name: true, status: true } })
      if (!u || u.status !== 'active') return
      await tx.authToken.updateMany({ where: { userId: u.id, kind: 'reset_password', usedAt: null }, data: { usedAt: new Date() } })
      const token = randomToken()
      await tx.authToken.create({
        data: { userId: u.id, kind: 'reset_password', tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
      })
      await this.jobs.email(addr, 'reset_password', { name: u.name, link: `${this.env.appBaseUrl}/reset-password?token=${token}` })
      await this.audit.log('auth.password_reset_requested', { actorId: u.id, targetType: 'user', targetId: u.id })
    })
  }

  async resetPassword(token: string, password: string) {
    const peek = await this.db.asAuth(async () => {
      const t = await this.db.tx.authToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: { select: { email: true, name: true } } } })
      if (!t || t.kind !== 'reset_password' || t.usedAt || t.expiresAt < new Date()) return null
      return { userEmail: t.user.email, userName: t.user.name }
    })
    if (!peek) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_token', 'This link is invalid or has expired')
    assertAcceptablePassword(password, { email: peek.userEmail, name: peek.userName })
    const passwordHash = await this.pw.hash(password)

    const sessions = await this.db.asAuth(async () => {
      const tx = this.db.tx
      const t = await tx.authToken.findUnique({ where: { tokenHash: sha256(token) } })
      if (!t || t.usedAt || t.expiresAt < new Date()) {
        throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_token', 'This link is invalid or has expired')
      }
      const claimed = await tx.authToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } })
      if (claimed.count === 0) throw new ApiError(HttpStatus.BAD_REQUEST, 'invalid_token', 'This link is invalid or has expired')
      await tx.user.update({
        where: { id: t.userId },
        data: { passwordHash, passwordChangedAt: new Date(), lockedUntil: null, failedLoginCount: 0, emailVerifiedAt: new Date() },
      })
      const ids = await this.revokeAll(t.userId, 'password_reset')
      await this.jobs.email(peek.userEmail, 'password_changed', { name: peek.userName })
      await this.audit.log('auth.password_reset', { actorId: t.userId, targetType: 'user', targetId: t.userId })
      return ids
    })
    await this.tokens.markRevoked(sessions)
  }

  /** Password change by a signed-in user: also signs every other device out. */
  async changePassword(userId: string, sessionId: string, current: string, next: string) {
    const u = await this.db.tx.user.findUniqueOrThrow({ where: { id: userId } })
    if (!u.passwordHash || !(await this.pw.verify(u.passwordHash, current))) {
      throw unprocessable('wrong_password', 'The current password is incorrect', [{ field: 'current', message: 'Incorrect password' }])
    }
    assertAcceptablePassword(next, { email: u.email, name: u.name })
    const passwordHash = await this.pw.hash(next)
    await this.db.tx.user.update({ where: { id: userId }, data: { passwordHash, passwordChangedAt: new Date() } })
    const revoked = await this.revokeAll(userId, 'password_changed', sessionId)
    await this.jobs.email(u.email, 'password_changed', { name: u.name })
    await this.audit.log('auth.password_changed', { actorId: userId, targetType: 'user', targetId: userId })
    await this.tokens.markRevoked(revoked)
  }

  /** Revoke sessions (all, or all except one). Returns the revoked ids. */
  async revokeAll(userId: string, reason: string, exceptSessionId?: string): Promise<string[]> {
    const tx = this.db.tx
    const live = await tx.session.findMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      select: { id: true },
    })
    if (live.length) {
      await tx.session.updateMany({ where: { id: { in: live.map((s) => s.id) } }, data: { revokedAt: new Date(), revokedReason: reason } })
    }
    return live.map((s) => s.id)
  }
}
