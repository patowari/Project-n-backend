import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import { WorkspaceType } from '@prisma/client'
import { createHash, randomBytes } from 'node:crypto'
import { ApiError } from '../../common/http'
import { ENV, Env } from '../../config/env'
import { Db } from '../../infra/db'
import { KvService } from '../../infra/kv'
import { IdentityError, IdentityPort } from '../../integrations/identity.port'
import { AuditService } from '../core/core.services'
import { AuthService } from './auth.service'
import { TokenService } from './token.service'

type Mode = 'sign_in' | 'sign_up' | 'link'

interface Pending {
  mode: Mode
  verifier: string
  nonce: string
  userId?: string
  workspaceType?: WorkspaceType
  workspaceName?: string
  next?: string
}

export interface GoogleOutcome {
  /** Where the browser goes next. */
  redirect: string
  /** Set when a session was created: the controller puts it in the httpOnly cookie. */
  refreshToken?: string
}

const STATE_TTL_SEC = 600

/** Only same-site relative paths: never an absolute URL (open-redirect guard). */
export function safeNext(next: string | undefined): string | undefined {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\r\n]/.test(next)) return undefined
  return next.slice(0, 300)
}

/**
 * Sign in / sign up / link with Google (OpenID Connect + PKCE + state + nonce).
 *
 * Account rules:
 *  - A Google account is identified by its `sub`, never by e-mail alone.
 *  - First sign-in with an e-mail that already has an account links it, but only because Google says
 *    the e-mail is verified. If that account's e-mail was never verified, its password is removed:
 *    whoever pre-registered the address (possibly an attacker) cannot keep a way in.
 *  - An account already linked to a different Google account is never silently re-linked.
 *  - Sign-in does not create accounts; sign-up does, with the same workspace rules as e-mail sign-up.
 */
@Injectable()
export class GoogleAuthService {
  private readonly log = new Logger('GoogleAuth')

  constructor(
    private db: Db,
    private idp: IdentityPort,
    private kvs: KvService,
    private auth: AuthService,
    private tokens: TokenService,
    private audit: AuditService,
    @Inject(ENV) private env: Env
  ) {}

  private async begin(p: Omit<Pending, 'verifier' | 'nonce'>) {
    const state = randomBytes(24).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const nonce = randomBytes(16).toString('base64url')
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url')
    await this.kvs.kv.set(`gauth:${state}`, JSON.stringify({ ...p, verifier, nonce } satisfies Pending), STATE_TTL_SEC)
    let url = this.idp.authorizeUrl({ state, nonce, codeChallenge })
    if (url.startsWith('/')) url = new URL(this.env.googleRedirectBase).origin + url
    return { authorizeUrl: url }
  }

  start(input: { mode: 'sign_in' | 'sign_up'; workspaceType?: WorkspaceType; workspaceName?: string; next?: string }) {
    if (input.mode === 'sign_up' && (!input.workspaceType || !input.workspaceName?.trim())) {
      throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'workspace_required', 'Choose a workspace type and name to sign up', [
        { field: 'workspace_name', message: 'Required' },
      ])
    }
    return this.begin({
      mode: input.mode,
      workspaceType: input.mode === 'sign_up' ? input.workspaceType : undefined,
      workspaceName: input.mode === 'sign_up' ? input.workspaceName?.trim() : undefined,
      next: safeNext(input.next),
    })
  }

  startLink(userId: string) {
    return this.begin({ mode: 'link', userId })
  }

  async unlink(userId: string) {
    const u = await this.db.tx.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, googleSub: true } })
    if (!u.googleSub) return
    if (!u.passwordHash) {
      throw new ApiError(HttpStatus.CONFLICT, 'password_required', 'Set a password first (use "Forgot password"), otherwise you could not sign in again')
    }
    await this.db.tx.user.update({ where: { id: userId }, data: { googleSub: null } })
    await this.audit.log('auth.google_unlinked', { actorId: userId, targetType: 'user', targetId: userId })
  }

  /** Browser callback from Google. Never throws: every failure becomes a redirect with an error code. */
  async finish(state: string, code: string | undefined, googleError: string | undefined): Promise<GoogleOutcome> {
    const raw = state ? await this.kvs.kv.get(`gauth:${state}`) : null
    if (!raw) return { redirect: this.landing({ error: 'expired' }) }
    await this.kvs.kv.del(`gauth:${state}`)
    const p = JSON.parse(raw) as Pending
    const fail = (error: string): GoogleOutcome => ({ redirect: p.mode === 'link' ? this.securityPage(error) : this.landing({ error }) })
    if (googleError || !code) return fail('denied')

    let profile
    try {
      profile = await this.idp.exchange(code, p.verifier, p.nonce)
    } catch (e) {
      this.log.warn(`google exchange failed: ${e instanceof IdentityError ? e.message : e}`)
      return fail('google_error')
    }
    if (!profile.emailVerified) return fail('email_not_verified')

    try {
      return p.mode === 'link' ? await this.link(p, profile) : await this.signInOrUp(p, profile)
    } catch (e) {
      this.log.error(`google ${p.mode} failed: ${e instanceof Error ? (e.stack ?? e.message) : e}`)
      return fail('server_error')
    }
  }

  private landing(q: Record<string, string | undefined>) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])
    return `${this.env.appBaseUrl}/google-callback?${qs}`
  }

  private securityPage(result: string) {
    return `${this.env.appBaseUrl}/settings/security?google=${result}`
  }

  private async link(p: Pending, profile: { sub: string; email: string }): Promise<GoogleOutcome> {
    return this.db.asAuth(async () => {
      const tx = this.db.tx
      const owner = await tx.user.findUnique({ where: { googleSub: profile.sub }, select: { id: true } })
      if (owner && owner.id !== p.userId) return { redirect: this.securityPage('in_use') }
      const me = await tx.user.findUnique({ where: { id: p.userId! }, select: { googleSub: true } })
      if (!me) return { redirect: this.securityPage('server_error') }
      if (me.googleSub && me.googleSub !== profile.sub) return { redirect: this.securityPage('different_account') }
      await tx.user.update({ where: { id: p.userId! }, data: { googleSub: profile.sub } })
      await this.audit.log('auth.google_linked', { actorId: p.userId, targetType: 'user', targetId: p.userId })
      return { redirect: this.securityPage('linked') }
    })
  }

  private async signInOrUp(
    p: Pending,
    profile: { sub: string; email: string; name: string; picture: string | null }
  ): Promise<GoogleOutcome> {
    const result = await this.db.asAuth(async () => {
      const tx = this.db.tx
      let user = await tx.user.findUnique({ where: { googleSub: profile.sub } })
      let created = false
      let revoked: string[] = []

      if (!user) {
        const byEmail = await tx.user.findUnique({ where: { email: profile.email } })
        if (byEmail) {
          if (byEmail.googleSub && byEmail.googleSub !== profile.sub) return { error: 'different_account' as const }
          const data: { googleSub: string; emailVerifiedAt?: Date; passwordHash?: null; passwordChangedAt?: Date } = { googleSub: profile.sub }
          if (!byEmail.emailVerifiedAt) {
            // Pre-registration takeover guard: the address was claimed before its owner proved it.
            data.emailVerifiedAt = new Date()
            data.passwordHash = null
            data.passwordChangedAt = new Date()
            revoked = await this.auth.revokeAll(byEmail.id, 'google_link_unverified_email')
            await this.audit.log('auth.google_removed_unverified_password', { actorId: byEmail.id, targetType: 'user', targetId: byEmail.id })
          }
          user = await tx.user.update({ where: { id: byEmail.id }, data })
          await this.audit.log('auth.google_linked', { actorId: user.id, targetType: 'user', targetId: user.id, data: { via: 'email_match' } })
        } else if (p.mode === 'sign_up') {
          user = await tx.user.create({
            data: { email: profile.email, name: profile.name, googleSub: profile.sub, avatarUrl: profile.picture, emailVerifiedAt: new Date() },
          })
          await this.db.setUser(user.id)
          const status = p.workspaceType === 'supervision' ? ('active' as const) : ('pending_approval' as const)
          const ws = await this.auth.createOwnerWorkspace(user.id, p.workspaceType!, p.workspaceName!, status)
          await this.audit.log('auth.signup', { actorId: user.id, workspaceId: ws.id, targetType: 'workspace', targetId: ws.id, data: { via: 'google' } })
          created = true
        } else {
          return { error: 'no_account' as const }
        }
      }

      if (user.status !== 'active') return { error: 'account_disabled' as const }
      const { refreshToken, sessionId } = await this.auth.createSession(user.id)
      await this.db.setUser(user.id)
      await this.audit.log('auth.login', { actorId: user.id, targetType: 'session', targetId: sessionId, data: { via: 'google' } })
      return { refreshToken, created, revoked }
    })

    if ('error' in result) return { redirect: this.landing({ error: result.error, email: result.error === 'no_account' ? profile.email : undefined }) }
    if (result.revoked.length) await this.tokens.markRevoked(result.revoked)
    return { redirect: this.landing({ status: result.created ? 'created' : 'ok', next: p.next }), refreshToken: result.refreshToken }
  }
}
