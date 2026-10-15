import { Inject, Injectable } from '@nestjs/common'
import { JobStatus, Prisma, WorkspaceStatus } from '@prisma/client'
import { Caller } from '../../authz/caller'
import { randomToken, sha256 } from '../../common/crypto'
import { clampLimit, conflict, decodeCursor, encodeCursor, notFound, unprocessable } from '../../common/http'
import { ENV, Env } from '../../config/env'
import { SystemPrismaService } from '../../infra/prisma.service'
import { JobsService } from '../core/core.services'

/**
 * Super Admin: the platform owner (architecture 5.3).
 *
 * Sees institutions, plans, usage and failed jobs. NEVER project content:
 * this service only touches workspace metadata, counts and the job table,
 * and job payloads are never returned (they can hold one-time links).
 * Because the Super Admin has no membership in any workspace, the
 * row-level-security policies also hide all content from this user in the
 * ordinary API (see test/access.e2e-spec.ts).
 */
@Injectable()
export class AdminService {
  constructor(
    private sys: SystemPrismaService,
    private jobs: JobsService,
    @Inject(ENV) private env: Env
  ) {}

  private audit(actor: Caller, action: string, targetId?: string, data?: Record<string, unknown>) {
    return this.sys.auditLog.create({ data: { actorId: actor.userId, action, targetType: 'workspace', targetId, data: (data ?? {}) as Prisma.InputJsonValue } })
  }

  async overview() {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
    const [byStatus, users, projects, jobs, ai] = await Promise.all([
      this.sys.workspace.groupBy({ by: ['status'], _count: true }),
      this.sys.user.count({ where: { status: 'active' } }),
      this.sys.project.count({ where: { deletedAt: null } }),
      this.sys.job.groupBy({ by: ['status'], _count: true }),
      this.sys.aiUsage.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { costUsd: true, tokensIn: true, tokensOut: true } }),
    ])
    const count = <T extends string>(rows: { status: T; _count: number }[], k: T) => rows.find((r) => r.status === k)?._count ?? 0
    return {
      institutions: { active: count(byStatus, 'active'), pendingApproval: count(byStatus, 'pending_approval'), suspended: count(byStatus, 'suspended') },
      users,
      projects,
      jobs: { queued: count(jobs, 'queued'), running: count(jobs, 'running'), failed: count(jobs, 'dead') },
      ai: { spentUsd: Number(ai._sum.costUsd ?? 0), tokensIn: ai._sum.tokensIn ?? 0, tokensOut: ai._sum.tokensOut ?? 0 },
    }
  }

  async institutions(q: { status?: WorkspaceStatus; type?: 'institution' | 'supervision'; search?: string; cursor?: string; limit?: number }) {
    const limit = clampLimit(q.limit)
    const cur = decodeCursor(q.cursor)
    const rows = await this.sys.workspace.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.type ? { type: q.type } : {}),
        ...(q.search ? { name: { contains: q.search.slice(0, 80), mode: 'insensitive' as const } } : {}),
        ...(cur ? { OR: [{ createdAt: { lt: new Date(cur.t) } }, { createdAt: new Date(cur.t), id: { lt: cur.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { plan: { select: { key: true, name: true } }, _count: { select: { memberships: true, projects: true } } },
    })
    const more = rows.length > limit
    const items = more ? rows.slice(0, limit) : rows
    const owners = await this.sys.membershipRole.findMany({
      where: { workspaceId: { in: items.map((i) => i.id) }, role: { in: ['institution_admin', 'supervision_owner'] } },
      select: { workspaceId: true, membership: { select: { user: { select: { name: true, email: true } } } } },
    })
    const last = items[items.length - 1]
    return {
      items: items.map((w) => ({
        id: w.id, name: w.name, type: w.type, status: w.status, createdAt: w.createdAt, plan: w.plan,
        members: w._count.memberships, projects: w._count.projects,
        admins: owners.filter((o) => o.workspaceId === w.id).map((o) => o.membership.user),
      })),
      nextCursor: more && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    }
  }

  /** Approve a pending institution, suspend or reactivate one. */
  async setStatus(actor: Caller, id: string, to: 'active' | 'suspended') {
    const ws = await this.sys.workspace.findUnique({ where: { id } })
    if (!ws) throw notFound('Institution')
    if (ws.status === to) return
    await this.sys.workspace.update({ where: { id }, data: { status: to } })
    await this.audit(actor, `admin.workspace_${to === 'active' ? (ws.status === 'pending_approval' ? 'approved' : 'reactivated') : 'suspended'}`, id, { from: ws.status })
    const admins = await this.sys.membershipRole.findMany({
      where: { workspaceId: id, role: { in: ['institution_admin', 'supervision_owner'] }, membership: { status: 'active' } },
      select: { membership: { select: { user: { select: { id: true, email: true } } } } },
    })
    for (const a of admins) {
      await this.jobs.email(a.membership.user.email, 'notification', {
        title: to === 'active' ? `${ws.name} is approved` : `${ws.name} was suspended`,
        body: to === 'active' ? 'Your institution is ready. Sign in to set up faculties, departments and people.' : 'Please contact support.',
        link: `${this.env.appBaseUrl}/sign-in`,
      }, { workspaceId: id }, this.sys)
    }
  }

  /** "Create institutions and their first Admin": the Admin receives an invitation. */
  async createInstitution(actor: Caller, v: { name: string; adminName: string; adminEmail: string }) {
    const email = v.adminEmail.trim().toLowerCase()
    const token = randomToken()
    const ws = await this.sys.$transaction(async (tx) => {
      const w = await tx.workspace.create({ data: { name: v.name.trim(), shortName: v.name.trim().slice(0, 24), type: 'institution', status: 'active', settings: { create: {} } } })
      await tx.invite.create({
        data: { workspaceId: w.id, email, name: v.adminName.trim(), role: 'institution_admin', tokenHash: sha256(token), invitedById: actor.userId, expiresAt: new Date(Date.now() + 7 * 86_400_000) },
      })
      return w
    })
    await this.jobs.email(email, 'invite', { name: v.adminName, workspaceName: ws.name, invitedBy: 'Project N', role: 'institution_admin', link: `${this.env.appBaseUrl}/invite/${token}` }, { workspaceId: ws.id }, this.sys)
    await this.audit(actor, 'admin.workspace_created', ws.id)
    return { id: ws.id }
  }

  /* -------------------------------- plans -------------------------------- */

  plans() {
    return this.sys.plan.findMany({ orderBy: { key: 'asc' } }).then((rows) =>
      rows.map((p) => ({ id: p.id, key: p.key, name: p.name, aiMonthlyBudgetUsd: Number(p.aiMonthlyBudgetUsd), maxUsers: p.maxUsers }))
    )
  }

  async savePlan(actor: Caller, id: string | undefined, v: { key: string; name: string; aiMonthlyBudgetUsd: number; maxUsers?: number | null }) {
    if (!/^[a-z0-9_-]{2,30}$/.test(v.key)) throw unprocessable('invalid_plan', 'key must be 2-30 lowercase letters, digits, - or _')
    const data = { key: v.key, name: v.name.trim(), aiMonthlyBudgetUsd: v.aiMonthlyBudgetUsd, maxUsers: v.maxUsers ?? null }
    const p = id ? await this.sys.plan.update({ where: { id }, data }) : await this.sys.plan.create({ data })
    await this.audit(actor, 'admin.plan_saved', p.id)
    return { id: p.id }
  }

  /** Assigning a plan sets the workspace's monthly AI budget. */
  async assignPlan(actor: Caller, workspaceId: string, planId: string | null) {
    const ws = await this.sys.workspace.findUnique({ where: { id: workspaceId } })
    if (!ws) throw notFound('Institution')
    const plan = planId ? await this.sys.plan.findUnique({ where: { id: planId } }) : null
    if (planId && !plan) throw notFound('Plan')
    await this.sys.workspace.update({ where: { id: workspaceId }, data: { planId } })
    if (plan) await this.sys.workspaceSettings.update({ where: { workspaceId }, data: { aiMonthlyBudgetUsd: plan.aiMonthlyBudgetUsd } })
    await this.audit(actor, 'admin.plan_assigned', workspaceId, { planId })
  }

  /** Usage per institution: counts and AI spend, never content. */
  async usage() {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
    const [ws, ai, subs] = await Promise.all([
      this.sys.workspace.findMany({ select: { id: true, name: true, type: true, status: true, settings: { select: { aiMonthlyBudgetUsd: true } }, _count: { select: { memberships: true, projects: true } } }, take: 500, orderBy: { name: 'asc' } }),
      this.sys.aiUsage.groupBy({ by: ['workspaceId'], where: { createdAt: { gte: monthStart } }, _sum: { costUsd: true } }),
      this.sys.submission.groupBy({ by: ['workspaceId'], where: { submittedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _count: true }),
    ])
    return {
      items: ws.map((w) => ({
        id: w.id, name: w.name, type: w.type, status: w.status, members: w._count.memberships, projects: w._count.projects,
        submissionsLast30Days: subs.find((s) => s.workspaceId === w.id)?._count ?? 0,
        aiSpentUsd: Number(ai.find((a) => a.workspaceId === w.id)?._sum.costUsd ?? 0),
        aiBudgetUsd: Number(w.settings?.aiMonthlyBudgetUsd ?? 0),
      })),
      nextCursor: null,
    }
  }

  /* --------------------------------- jobs --------------------------------- */

  async failedJobs(status: JobStatus | undefined, limit?: number) {
    const rows = await this.sys.job.findMany({
      where: { status: status ?? 'dead' },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(limit),
      select: { id: true, kind: true, status: true, attempts: true, maxAttempts: true, lastError: true, runAt: true, createdAt: true, finishedAt: true, workspaceId: true },
    })
    return { items: rows, nextCursor: null }
  }

  async retryJob(actor: Caller, id: string) {
    const r = await this.sys.job.updateMany({ where: { id, status: 'dead' }, data: { status: 'queued', attempts: 0, runAt: new Date(), lastError: null, finishedAt: null } })
    if (r.count === 0) throw conflict('not_retryable', 'Only failed jobs can be retried')
    await this.sys.auditLog.create({ data: { actorId: actor.userId, action: 'admin.job_retried', targetType: 'job', targetId: id } })
  }
}
