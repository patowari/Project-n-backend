import { Inject, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { Caller } from '../../authz/caller'
import { conflict, notFound, unprocessable } from '../../common/http'
import { randomToken, sha256 } from '../../common/crypto'
import { Db } from '../../infra/db'
import { AuditService, JobsService } from '../core/core.services'
import { AuthService } from '../auth/auth.service'
import { TokenService } from '../auth/token.service'
import { InviteAcceptanceService } from '../auth/invite-acceptance.service'
import { ENV, Env } from '../../config/env'

export const EVENTS = ['submissions', 'reviews', 'comments', 'deadlines', 'extensions', 'escalations', 'people'] as const

export const DEFAULT_NOTIFICATIONS = {
  events: Object.fromEntries(EVENTS.map((e) => [e, { email: true, inApp: true }])) as Record<string, { email: boolean; inApp: boolean }>,
  delivery: 'instant' as 'instant' | 'daily' | 'weekly',
  reminderDays: 3,
}
export const DEFAULT_PREFERENCES = { timeZone: 'Asia/Dhaka', weekStartsOn: 'saturday' as 'saturday' | 'sunday' | 'monday' }
export const DEFAULT_SUPERVISION = {
  unlockRule: 'on_submit' as 'on_submit' | 'on_approval',
  submissionMode: 'leader_only' as 'leader_only' | 'any_member',
  aiStudentFeedback: true,
  aiRelease: 'after_review' as 'immediate' | 'after_review',
  aiSupervisorSummary: true,
  reviewWithinDays: 3,
}

type Json = Record<string, unknown>
const merge = <T extends Json>(defaults: T, saved: unknown): T => ({ ...defaults, ...((saved as Json) ?? {}) })

@Injectable()
export class MeSettingsService {
  constructor(
    private db: Db,
    private auth: AuthService,
    private tokens: TokenService,
    private invites: InviteAcceptanceService,
    private jobs: JobsService,
    private audit: AuditService,
    @Inject(ENV) private env: Env
  ) {}

  private get tx() {
    return this.db.tx
  }

  /* ---- profile ---- */

  async profile(c: Caller) {
    const u = await this.tx.user.findUniqueOrThrow({ where: { id: c.userId } })
    const extra = (u.profile ?? {}) as Json
    let studentId = ''
    if (c.workspaceId) {
      const m = await this.tx.membership.findFirst({ where: { workspaceId: c.workspaceId, userId: c.userId }, select: { studentCode: true } })
      studentId = m?.studentCode ?? ''
    }
    return {
      name: u.name,
      email: u.email,
      title: u.title,
      phone: u.phone,
      studentId,
      batch: String(extra.batch ?? ''),
      researchInterests: String(extra.researchInterests ?? ''),
      officeHours: String(extra.officeHours ?? ''),
      bio: String(extra.bio ?? ''),
      avatarUrl: u.avatarUrl,
    }
  }

  async updateProfile(c: Caller, v: Json) {
    const u = await this.tx.user.findUniqueOrThrow({ where: { id: c.userId } })
    const extra = { ...((u.profile ?? {}) as Json) }
    for (const k of ['batch', 'researchInterests', 'officeHours', 'bio'] as const) {
      if (typeof v[k] === 'string') extra[k] = (v[k] as string).slice(0, 2000)
    }
    const data: Prisma.UserUpdateInput = { profile: extra as Prisma.InputJsonValue }
    if (typeof v.name === 'string' && v.name.trim().length >= 2) data.name = v.name.trim().slice(0, 120)
    if (typeof v.title === 'string') data.title = v.title.slice(0, 20)
    if (typeof v.phone === 'string') data.phone = v.phone.slice(0, 40)
    if (v.avatarUrl === null || typeof v.avatarUrl === 'string') {
      const url = v.avatarUrl as string | null
      if (url && !/^(https:\/\/|data:image\/(png|jpeg|webp);base64,)/.test(url)) {
        throw unprocessable('invalid_avatar', 'Avatar must be an https URL or a small image')
      }
      if (url && url.length > 400_000) throw unprocessable('avatar_too_large', 'Choose an image under 2 MB')
      data.avatarUrl = url
    }
    await this.tx.user.update({ where: { id: c.userId }, data })
  }

  /* ---- security ---- */

  async security(c: Caller) {
    const [u, sessions, pending] = await Promise.all([
      this.tx.user.findUniqueOrThrow({ where: { id: c.userId } }),
      this.tx.session.findMany({ where: { userId: c.userId, revokedAt: null }, orderBy: { lastSeenAt: 'desc' }, take: 50 }),
      this.tx.authToken.findFirst({ where: { userId: c.userId, kind: 'change_email', usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }),
    ])
    return {
      passwordChangedAt: u.passwordChangedAt,
      googleLinked: u.googleSub !== null,
      pendingEmail: (pending?.payload as { email?: string } | null)?.email ?? null,
      sessions: sessions.map((s) => ({
        id: s.id,
        device: s.deviceLabel,
        location: s.location || s.ip || '',
        lastActiveAt: s.lastSeenAt,
        current: s.id === c.sessionId,
      })),
    }
  }

  changePassword(c: Caller, current: string, next: string) {
    return this.auth.changePassword(c.userId, c.sessionId, current, next)
  }

  async requestEmailChange(c: Caller, email: string) {
    const addr = email.trim().toLowerCase()
    const taken = await this.db.asAuth(() => this.tx.user.findUnique({ where: { email: addr }, select: { id: true } }))
    if (taken) {
      // Same answer as success: do not reveal which addresses are registered.
      return
    }
    await this.tx.authToken.updateMany({ where: { userId: c.userId, kind: 'change_email', usedAt: null }, data: { usedAt: new Date() } })
    const token = randomToken()
    await this.tx.authToken.create({
      data: { userId: c.userId, kind: 'change_email', tokenHash: sha256(token), payload: { email: addr }, expiresAt: new Date(Date.now() + 24 * 3600_000) },
    })
    await this.jobs.email(addr, 'change_email', { name: c.name, link: `${this.env.appBaseUrl}/verify-email?token=${token}&change=1` })
    await this.audit.log('auth.email_change_requested', { actorId: c.userId, targetType: 'user', targetId: c.userId })
  }

  async revokeSession(c: Caller, id: string) {
    const s = await this.tx.session.findFirst({ where: { id, userId: c.userId, revokedAt: null } })
    if (!s) throw notFound('Session')
    await this.tx.session.update({ where: { id }, data: { revokedAt: new Date(), revokedReason: 'user_revoked' } })
    await this.audit.log('auth.session_revoked', { actorId: c.userId, targetType: 'session', targetId: id })
    await this.tokens.markRevoked([id])
  }

  async revokeOthers(c: Caller) {
    const ids = await this.auth.revokeAll(c.userId, 'user_revoked_others', c.sessionId)
    await this.audit.log('auth.sessions_revoked_others', { actorId: c.userId, data: { count: ids.length } })
    await this.tokens.markRevoked(ids)
  }

  /* ---- preferences (stored on the user) ---- */

  async notificationPrefs(c: Caller) {
    const u = await this.tx.user.findUniqueOrThrow({ where: { id: c.userId }, select: { notificationPrefs: true } })
    const saved = (u.notificationPrefs ?? {}) as Json
    return { ...DEFAULT_NOTIFICATIONS, ...saved, events: { ...DEFAULT_NOTIFICATIONS.events, ...((saved.events as Json) ?? {}) } }
  }

  async setNotificationPrefs(c: Caller, v: Json) {
    const events = (v.events ?? {}) as Record<string, { email?: unknown; inApp?: unknown }>
    const clean: Record<string, { email: boolean; inApp: boolean }> = {}
    for (const e of EVENTS) clean[e] = { email: events[e]?.email !== false, inApp: events[e]?.inApp !== false }
    if (!['instant', 'daily', 'weekly'].includes(String(v.delivery))) throw unprocessable('invalid_delivery', 'delivery must be instant, daily or weekly')
    const days = Number(v.reminderDays)
    if (!Number.isInteger(days) || days < 0 || days > 14) throw unprocessable('invalid_reminder_days', 'reminderDays must be 0 to 14')
    await this.tx.user.update({
      where: { id: c.userId },
      data: { notificationPrefs: { events: clean, delivery: v.delivery, reminderDays: days } as Prisma.InputJsonValue },
    })
  }

  async preferences(c: Caller) {
    const u = await this.tx.user.findUniqueOrThrow({ where: { id: c.userId }, select: { preferences: true } })
    return merge(DEFAULT_PREFERENCES, u.preferences)
  }

  async setPreferences(c: Caller, v: Json) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: String(v.timeZone) })
    } catch {
      throw unprocessable('invalid_time_zone', 'Unknown time zone')
    }
    if (!['saturday', 'sunday', 'monday'].includes(String(v.weekStartsOn))) throw unprocessable('invalid_week_start', 'weekStartsOn is invalid')
    await this.tx.user.update({ where: { id: c.userId }, data: { preferences: { timeZone: v.timeZone, weekStartsOn: v.weekStartsOn } as Prisma.InputJsonValue } })
  }

  async supervisionDefaults(c: Caller) {
    const u = await this.tx.user.findUniqueOrThrow({ where: { id: c.userId }, select: { supervisionDefaults: true } })
    return merge(DEFAULT_SUPERVISION, u.supervisionDefaults)
  }

  async setSupervisionDefaults(c: Caller, v: Json) {
    const d = DEFAULT_SUPERVISION
    const out = {
      unlockRule: ['on_submit', 'on_approval'].includes(String(v.unlockRule)) ? v.unlockRule : d.unlockRule,
      submissionMode: ['leader_only', 'any_member'].includes(String(v.submissionMode)) ? v.submissionMode : d.submissionMode,
      aiStudentFeedback: v.aiStudentFeedback !== false,
      aiRelease: ['immediate', 'after_review'].includes(String(v.aiRelease)) ? v.aiRelease : d.aiRelease,
      aiSupervisorSummary: v.aiSupervisorSummary !== false,
      reviewWithinDays: Math.min(30, Math.max(1, Number(v.reviewWithinDays) || d.reviewWithinDays)),
    }
    await this.tx.user.update({ where: { id: c.userId }, data: { supervisionDefaults: out as Prisma.InputJsonValue } })
  }

  /* ---- invitations and workspaces ---- */

  async myInvites(c: Caller) {
    return this.db.asAuth(async () => {
      const rows = await this.tx.invite.findMany({
        where: { email: c.email, status: 'pending', expiresAt: { gt: new Date() } },
        include: { workspace: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      })
      const inviters = await this.tx.user.findMany({ where: { id: { in: rows.map((r) => r.invitedById) } }, select: { id: true, name: true } })
      const names = new Map(inviters.map((u) => [u.id, u.name]))
      return rows.map((r) => ({
        id: r.id,
        workspaceName: r.workspace.name,
        role: r.role,
        invitedBy: names.get(r.invitedById) ?? '',
        expiresAt: r.expiresAt,
      }))
    })
  }

  respondInvite(c: Caller, id: string, accept: boolean) {
    return this.invites.decideById(c.userId, id, accept)
  }

  async defaultWorkspace(c: Caller): Promise<string | null> {
    const u = await this.tx.user.findUniqueOrThrow({ where: { id: c.userId }, select: { defaultWorkspaceId: true } })
    return u.defaultWorkspaceId
  }

  async setDefaultWorkspace(c: Caller, workspaceId: string) {
    const m = await this.tx.membership.findFirst({ where: { workspaceId, userId: c.userId, status: 'active' } })
    if (!m) throw notFound('Workspace')
    await this.tx.user.update({ where: { id: c.userId }, data: { defaultWorkspaceId: workspaceId } })
  }

  /** Leaving ends the membership; history keeps the person's name (snapshots). */
  async leaveWorkspace(c: Caller, workspaceId: string) {
    await this.db.inWorkspace(workspaceId, async () => {
      const m = await this.tx.membership.findFirst({ where: { workspaceId, userId: c.userId, status: 'active' }, include: { roles: true } })
      if (!m) throw notFound('Membership')
      const owners = await this.tx.membershipRole.count({ where: { workspaceId, role: { in: ['institution_admin', 'supervision_owner'] }, membership: { status: 'active' } } })
      const mine = m.roles.filter((r) => r.role === 'institution_admin' || r.role === 'supervision_owner').length
      if (mine > 0 && owners - mine < 1) {
        throw conflict('last_owner', 'You are the only administrator. Assign another one before leaving')
      }
      const active = await this.tx.projectMember.count({ where: { workspaceId, userId: c.userId, leftAt: null, role: 'lead' } })
      if (active > 0) throw conflict('has_projects_to_hand_over', 'You lead active projects. Ask a Dean or admin to offboard you so they are handed over')
      await this.tx.projectMember.updateMany({ where: { workspaceId, userId: c.userId, leftAt: null }, data: { leftAt: new Date(), leftReason: 'left_workspace' } })
      await this.tx.membership.update({ where: { id: m.id }, data: { status: 'deactivated' } })
      await this.audit.log('workspace.left', { actorId: c.userId, workspaceId, targetType: 'workspace', targetId: workspaceId })
    })
    const u = await this.tx.user.findUniqueOrThrow({ where: { id: c.userId }, select: { defaultWorkspaceId: true } })
    if (u.defaultWorkspaceId === workspaceId) await this.tx.user.update({ where: { id: c.userId }, data: { defaultWorkspaceId: null } })
  }

  /* ---- privacy ---- */

  async dataRequests(c: Caller) {
    const u = await this.tx.user.findUniqueOrThrow({ where: { id: c.userId } })
    const exports = await this.tx.$queryRaw<{ id: string; status: string; created_at: Date }[]>`
      SELECT id, status::text, created_at FROM jobs
      WHERE kind = 'data.export' AND payload->>'userId' = ${c.userId} ORDER BY created_at DESC LIMIT 10`.catch(() => [])
    return {
      exports: exports.map((j) => ({ id: j.id, requestedAt: j.created_at, status: j.status === 'succeeded' ? 'ready' : 'processing' })),
      deletion: u.deletionRequestedAt ? { requestedAt: u.deletionRequestedAt, reason: u.deletionReason ?? '' } : null,
    }
  }

  async requestExport(c: Caller) {
    await this.jobs.enqueue('data.export', { userId: c.userId }, { dedupeKey: `data.export:${c.userId}:${new Date().toISOString().slice(0, 10)}`, workspaceId: null })
    await this.audit.log('privacy.export_requested', { actorId: c.userId })
  }

  async requestDeletion(c: Caller, reason: string) {
    await this.tx.user.update({ where: { id: c.userId }, data: { deletionRequestedAt: new Date(), deletionReason: reason.slice(0, 1000) } })
    await this.audit.log('privacy.deletion_requested', { actorId: c.userId, targetType: 'user', targetId: c.userId })
  }

  async cancelDeletion(c: Caller) {
    await this.tx.user.update({ where: { id: c.userId }, data: { deletionRequestedAt: null, deletionReason: null } })
    await this.audit.log('privacy.deletion_cancelled', { actorId: c.userId, targetType: 'user', targetId: c.userId })
  }
}
