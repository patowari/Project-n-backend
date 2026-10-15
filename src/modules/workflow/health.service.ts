import { Injectable } from '@nestjs/common'
import { PhaseStatus, Prisma, ProjectHealth } from '@prisma/client'
import { ActivityService, JobsService, NotificationService } from '../core/core.services'

type Client = Prisma.TransactionClient

export interface HealthInput {
  now: Date
  projectStatus: string
  phases: { position: number; status: PhaseStatus; dueDate: Date | null; latestVersion: number }[]
  /** Last time a student did something (draft upload, submission, time log). */
  lastStudentActivity: Date
  /** Oldest unreviewed submission of the current phase, if any. */
  pendingSince: Date | null
  changesRequestedRounds: number
  atRiskAfterDays: number
  awaitingReviewAfterDays: number
}

const DAY = 86_400_000
const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())

/**
 * Architecture 10.2, first matching rule wins. Pure, so it is unit-tested
 * without a database and recomputed by workers on events and on a schedule.
 */
export function computeHealth(i: HealthInput): { health: ProjectHealth; reason: string } {
  if (i.phases.length > 0 && i.phases.every((p) => p.status === 'approved')) {
    return { health: 'completed', reason: 'All phases approved' }
  }
  const current = i.phases.find((p) => p.status !== 'approved')
  const today = dayStart(i.now)
  const working = current && (current.status === 'open' || current.status === 'changes_requested')

  if (current && working && current.dueDate && dayStart(current.dueDate) < today) {
    const days = Math.round((today - dayStart(current.dueDate)) / DAY)
    return { health: 'overdue', reason: `Phase ${current.position} was due ${days} day${days === 1 ? '' : 's'} ago` }
  }
  if (i.pendingSince && (i.now.getTime() - i.pendingSince.getTime()) / DAY > i.awaitingReviewAfterDays) {
    const days = Math.floor((i.now.getTime() - i.pendingSince.getTime()) / DAY)
    return { health: 'awaiting_review', reason: `Waiting for review for ${days} days` }
  }
  if (current && working && current.dueDate) {
    const left = Math.round((dayStart(current.dueDate) - today) / DAY)
    if (left <= 3) return { health: 'at_risk', reason: left === 0 ? 'Phase is due today and not submitted' : `Phase ${current.position} is due in ${left} day${left === 1 ? '' : 's'} and not submitted` }
  }
  const idle = Math.floor((i.now.getTime() - i.lastStudentActivity.getTime()) / DAY)
  if (idle >= i.atRiskAfterDays) return { health: 'at_risk', reason: `No student activity for ${idle} days` }
  if (current && i.changesRequestedRounds >= 2) {
    return { health: 'at_risk', reason: `${i.changesRequestedRounds} rounds of changes requested on phase ${current.position}` }
  }
  return { health: 'on_track', reason: '' }
}

@Injectable()
export class HealthService {
  constructor(
    private activity: ActivityService,
    private notifications: NotificationService,
    private jobs: JobsService
  ) {}

  /**
   * Recompute one project and persist. `db` is the system client in workers or
   * the request transaction in tests. Idempotent: running twice changes nothing.
   */
  async recompute(db: Client, projectId: string, now = new Date()): Promise<{ changed: boolean; health?: ProjectHealth }> {
    const project = await db.project.findUnique({
      where: { id: projectId },
      include: { department: { select: { id: true, facultyId: true } } },
    })
    if (!project || project.deletedAt) return { changed: false }
    const settings = await db.workspaceSettings.findUnique({ where: { workspaceId: project.workspaceId } })

    const [phases, lastSub, lastDraft, lastLog, pending, rounds] = await Promise.all([
      db.phase.findMany({ where: { projectId }, orderBy: { position: 'asc' }, select: { id: true, position: true, status: true, dueDate: true, latestVersion: true } }),
      db.submission.findFirst({ where: { projectId }, orderBy: { submittedAt: 'desc' }, select: { submittedAt: true } }),
      db.draftFile.findFirst({ where: { projectId }, orderBy: { uploadedAt: 'desc' }, select: { uploadedAt: true } }),
      db.timeLog.findFirst({ where: { projectId, kind: 'hours' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      db.submission.findFirst({ where: { projectId, status: 'submitted' }, orderBy: { submittedAt: 'asc' }, select: { submittedAt: true } }),
      this.currentRounds(db, projectId),
    ])
    // A project that has never had activity is measured from its start / creation.
    const baseline = new Date(Math.min(Math.max(project.startDate.getTime(), project.createdAt.getTime()), now.getTime()))
    const lastStudentActivity = new Date(Math.max(baseline.getTime(), ...[lastSub?.submittedAt, lastDraft?.uploadedAt, lastLog?.createdAt].filter((d): d is Date => !!d).map((d) => d.getTime())))

    const next = computeHealth({
      now,
      projectStatus: project.status,
      phases,
      lastStudentActivity,
      pendingSince: pending?.submittedAt ?? null,
      changesRequestedRounds: rounds,
      atRiskAfterDays: settings?.atRiskAfterDays ?? 14,
      awaitingReviewAfterDays: settings?.awaitingReviewAfterDays ?? 3,
    })

    // Projects on hold keep their last health but raise no alerts.
    const same = project.health === next.health && (project.healthReason ?? '') === next.reason
    if (same) {
      if (!project.healthUpdatedAt || now.getTime() - project.healthUpdatedAt.getTime() > 3600_000) {
        await db.project.update({ where: { id: projectId }, data: { healthUpdatedAt: now } })
      }
      return { changed: false, health: next.health }
    }
    await db.project.update({ where: { id: projectId }, data: { health: next.health, healthReason: next.reason || null, healthUpdatedAt: now } })

    if (project.status === 'active' && project.health !== next.health) {
      await this.activity.recordSystem(db, project.workspaceId, { id: project.id, departmentId: project.departmentId, facultyId: project.department?.facultyId ?? null }, {
        category: 'project',
        action: `is now ${next.health.replace('_', ' ')}`,
        targetType: 'project',
        targetId: project.id,
        targetLabel: project.title,
        before: project.health.replace('_', ' '),
        after: next.health.replace('_', ' '),
        reason: next.reason || undefined,
      })
      if (next.health === 'overdue' || next.health === 'at_risk') await this.escalate(db, project, next.health, next.reason)
    }
    return { changed: true, health: next.health }
  }

  private async currentRounds(db: Client, projectId: string): Promise<number> {
    const current = await db.phase.findFirst({ where: { projectId, status: { not: 'approved' } }, orderBy: { position: 'asc' }, select: { id: true } })
    if (!current) return 0
    return db.review.count({ where: { submission: { phaseId: current.id }, decision: 'changes_requested' } })
  }

  /** Supervisors first; Head and Dean as well once a project is overdue (10.2). */
  private async escalate(
    db: Client,
    project: { id: string; title: string; workspaceId: string; departmentId: string | null; department: { facultyId: string } | null },
    health: ProjectHealth,
    reason: string
  ) {
    const members = await db.projectMember.findMany({ where: { projectId: project.id, leftAt: null, role: { in: ['lead', 'co_supervisor'] } }, select: { userId: true } })
    const targets = new Set(members.map((m) => m.userId))
    if (health === 'overdue') {
      const roles = await db.membershipRole.findMany({
        where: {
          workspaceId: project.workspaceId,
          OR: [
            ...(project.departmentId ? [{ role: 'head' as const, scopeId: project.departmentId }] : []),
            ...(project.department ? [{ role: 'dean' as const, scopeId: project.department.facultyId }] : []),
            { role: 'supervision_owner' as const },
          ],
        },
        select: { membership: { select: { userId: true, status: true } } },
      })
      roles.filter((r) => r.membership.status === 'active').forEach((r) => targets.add(r.membership.userId))
    }
    await this.notifications.notifyWith(db, project.workspaceId, [...targets], {
      kind: 'escalations',
      title: `“${project.title}” is ${health === 'overdue' ? 'overdue' : 'at risk'}`,
      body: reason,
      link: `/projects/${project.id}`,
      data: { projectId: project.id, health },
    })
  }

  /** Hourly sweep: every active project, in small batches so one job stays short. */
  async enqueueSweep(db: Client, batch = 200): Promise<number> {
    let cursor: string | undefined
    let n = 0
    for (;;) {
      const rows = await db.project.findMany({
        where: { status: 'active', deletedAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: batch,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      })
      if (rows.length === 0) break
      await this.jobs.enqueue('health.recompute_batch', { projectIds: rows.map((r) => r.id) }, { dedupeKey: `health-batch:${rows[0].id}:${Math.floor(Date.now() / 3_600_000)}` }, db)
      n += rows.length
      cursor = rows[rows.length - 1].id
    }
    return n
  }
}
