import { Injectable } from '@nestjs/common'
import { ActivityCategory, Prisma } from '@prisma/client'
import { Caller, hasRole } from '../../authz/caller'
import { approvalBlocked, isSupervisorOn, leaderAuthority } from '../../authz/policy'
import { clampLimit, decodeCursor, encodeCursor, unprocessable } from '../../common/http'
import { Db } from '../../infra/db'
import { KvService } from '../../infra/kv'
import { isoDate, ProjectCore, ProjectSummaryView } from '../projects/project-core.service'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export interface ActivityFilters {
  from?: string
  to?: string
  project?: string
  person?: string
  type?: string
  department?: string
  overridesOnly?: boolean
  cursor?: string
  limit?: number
}

interface ActivityRow {
  id: string
  occurred_at: Date
  project_id: string | null
  phase_id: string | null
  actor_name: string
  acting_role: string
  category: ActivityCategory
  action: string
  target_label: string
  before: string | null
  after: string | null
  reason: string | null
  is_override: boolean
}

const CATEGORIES: ActivityCategory[] = ['submissions', 'reviews', 'ai', 'timeline', 'project', 'people', 'governance', 'drive', 'collaboration', 'time']

@Injectable()
export class InsightsService {
  constructor(
    private db: Db,
    private core: ProjectCore,
    private kvs: KvService
  ) {}

  private get tx() {
    return this.db.tx
  }

  /* ----------------------------- notifications ----------------------------- */

  async notifications(c: Caller, q: { unread?: boolean; cursor?: string; limit?: number }) {
    const limit = clampLimit(q.limit, 30)
    const cur = decodeCursor(q.cursor)
    const rows = await this.tx.notification.findMany({
      where: {
        userId: c.userId,
        OR: [{ workspaceId: c.workspaceId }, { workspaceId: null }],
        ...(q.unread ? { readAt: null } : {}),
        ...(cur ? { AND: [{ OR: [{ createdAt: { lt: new Date(cur.t) } }, { createdAt: new Date(cur.t), id: { lt: cur.id } }] }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })
    const more = rows.length > limit
    const items = more ? rows.slice(0, limit) : rows
    const last = items[items.length - 1]
    return {
      items: items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: !!n.readAt, createdAt: n.createdAt, data: n.data })),
      nextCursor: more && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null,
    }
  }

  async unreadCount(c: Caller): Promise<{ count: number }> {
    const count = await this.tx.notification.count({ where: { userId: c.userId, readAt: null, OR: [{ workspaceId: c.workspaceId }, { workspaceId: null }] } })
    return { count }
  }

  async markRead(c: Caller, ids: string[] | 'all') {
    await this.tx.notification.updateMany({
      where: { userId: c.userId, readAt: null, ...(ids === 'all' ? {} : { id: { in: ids } }) },
      data: { readAt: new Date() },
    })
  }

  /* ------------------------------- activity ------------------------------- */

  private async activityRows(f: ActivityFilters, limit: number, projectScope?: string): Promise<ActivityRow[]> {
    if (f.from && !DAY_RE.test(f.from)) throw unprocessable('invalid_date', 'from must be YYYY-MM-DD')
    if (f.to && !DAY_RE.test(f.to)) throw unprocessable('invalid_date', 'to must be YYYY-MM-DD')
    if (f.type && !CATEGORIES.includes(f.type as ActivityCategory)) throw unprocessable('invalid_type', 'Unknown activity type')
    const cur = decodeCursor(f.cursor)
    const ws = await this.tx.workspace.findFirst({ select: { timeZone: true } })
    const tz = ws?.timeZone ?? 'UTC'
    const project = projectScope ?? f.project
    const where: Prisma.Sql[] = [Prisma.sql`TRUE`]
    // Dates are the viewer's workspace days, not UTC days.
    if (f.from) where.push(Prisma.sql`occurred_at >= (${f.from}::date)::timestamp AT TIME ZONE ${tz}`)
    if (f.to) where.push(Prisma.sql`occurred_at < ((${f.to}::date + 1))::timestamp AT TIME ZONE ${tz}`)
    if (project) where.push(Prisma.sql`project_id = ${project}::uuid`)
    if (f.person) where.push(Prisma.sql`actor_name ILIKE ${'%' + f.person.replace(/[\\%_]/g, '\\$&') + '%'}`)
    if (f.type) where.push(Prisma.sql`category = ${f.type}::activity_category`)
    if (f.department) where.push(Prisma.sql`department_id = ${f.department}::uuid`)
    if (f.overridesOnly) where.push(Prisma.sql`is_override`)
    if (cur) where.push(Prisma.sql`(occurred_at, id) < (${cur.t}::timestamptz, ${cur.id}::uuid)`)
    return this.tx.$queryRaw<ActivityRow[]>`
      SELECT id, occurred_at, project_id, phase_id, actor_name, acting_role, category::text AS category, action,
             target_label, "before", "after", reason, is_override
      FROM activity_log
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${limit}`
  }

  private activityView(r: ActivityRow) {
    return {
      id: r.id,
      occurredAt: r.occurred_at,
      ...(r.project_id ? { projectId: r.project_id } : {}),
      actorName: r.actor_name,
      actingRole: r.acting_role,
      category: r.category,
      action: r.action,
      targetLabel: r.target_label,
      ...(r.phase_id ? { phaseId: r.phase_id } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.before ? { before: r.before } : {}),
      ...(r.after ? { after: r.after } : {}),
      ...(r.is_override ? { isOverride: true } : {}),
    }
  }

  /** The viewer's slice of history; Row Level Security decides what is in it. */
  async activity(f: ActivityFilters, projectScope?: string) {
    const limit = clampLimit(f.limit)
    const rows = await this.activityRows(f, limit + 1, projectScope)
    const more = rows.length > limit
    const items = more ? rows.slice(0, limit) : rows
    const last = items[items.length - 1]
    return { items: items.map((r) => this.activityView(r)), nextCursor: more && last ? encodeCursor({ t: last.occurred_at.toISOString(), id: last.id }) : null }
  }

  /** CSV for Dean / Head / Owner. Cells that could run as formulas are neutralised. */
  async activityCsv(c: Caller, f: ActivityFilters): Promise<string> {
    const rows = await this.activityRows({ ...f, cursor: undefined }, 10_000)
    const esc = (v: unknown) => {
      let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v)
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
      return `"${s.replace(/"/g, '""')}"`
    }
    const head = ['occurred_at', 'actor', 'acting_role', 'category', 'action', 'project', 'before', 'after', 'reason', 'override']
    const lines = rows.map((r) => [r.occurred_at, r.actor_name, r.acting_role, r.category, r.action, r.target_label, r.before, r.after, r.reason, r.is_override ? 'yes' : ''].map(esc).join(','))
    void c
    return [head.join(','), ...lines].join('\n')
  }

  /* ------------------------------- calendar ------------------------------- */

  async calendar(from: string, to: string) {
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw unprocessable('invalid_date', 'from and to must be YYYY-MM-DD')
    if (from > to) throw unprocessable('invalid_range', 'from must not be after to')
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) throw unprocessable('range_too_large', 'Ask for at most 400 days')
    const [phases, meetings] = await Promise.all([
      this.tx.phase.findMany({
        where: { dueDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) }, project: { deletedAt: null, status: { in: ['active', 'on_hold', 'completed'] } } },
        include: { project: { select: { id: true, title: true } } },
        orderBy: { dueDate: 'asc' },
        take: 1500,
      }),
      this.tx.timeLog.findMany({
        where: { kind: 'meeting', date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
        include: { project: { select: { id: true, title: true } } },
        orderBy: { date: 'asc' },
        take: 500,
      }),
    ])
    const items = [
      ...phases.map((p) => ({ id: `deadline:${p.id}`, date: isoDate(p.dueDate)!, kind: 'deadline' as const, projectId: p.project.id, projectTitle: p.project.title, phaseId: p.id, title: `Phase ${p.position}: ${p.name}`, status: p.status })),
      ...meetings.map((m) => ({ id: `meeting:${m.id}`, date: isoDate(m.date)!, kind: 'meeting' as const, projectId: m.project.id, projectTitle: m.project.title, title: m.note ? `Meeting: ${m.note}` : 'Meeting' })),
    ].sort((a, b) => a.date.localeCompare(b.date))
    return { items, nextCursor: null }
  }

  /* ----------------------------- review queue ----------------------------- */

  /**
   * Supervisors: versions waiting on them (and recent decisions). The Dean /
   * Owner additionally sees versions whose project has nobody able to approve.
   */
  async reviewQueue(c: Caller) {
    const since = new Date(Date.now() - 14 * 86_400_000)
    const rows = await this.tx.submission.findMany({
      where: { OR: [{ status: 'submitted' }, { reviews: { some: { createdAt: { gte: since } } } }] },
      include: { phase: { select: { id: true, name: true, dueDate: true } }, project: { select: { id: true, title: true } } },
      orderBy: { submittedAt: 'desc' },
      take: 300,
    })
    const loaded = await this.core.load([...new Set(rows.map((r) => r.projectId))], { phases: false })
    const items = rows
      .map((r) => ({ r, l: loaded.get(r.projectId) }))
      .filter((x): x is { r: (typeof rows)[number]; l: NonNullable<typeof x.l> } => !!x.l)
      .filter(({ r, l }) => {
        if (isSupervisorOn(c, l.facts)) return true
        const a = leaderAuthority(c, l.facts)
        return (a === 'dean' || a === 'owner') && r.status === 'submitted' && approvalBlocked(l.facts)
      })
    const people = await this.core.people(items.map(({ r }) => r.submittedById))
    return {
      items: items.map(({ r, l }) => ({
        id: r.id,
        project: { id: r.project.id, name: r.project.title },
        phase: { id: r.phase.id, name: r.phase.name },
        version: r.version,
        status: r.status,
        submittedBy: people.get(r.submittedById) ?? { id: r.submittedById, name: 'Unknown' },
        submittedAt: r.submittedAt,
        dueDate: isoDate(r.phase.dueDate),
        aiSummaryReady: r.aiStatus === 'ready',
        approvalBlocked: approvalBlocked(l.facts),
      })),
      nextCursor: null,
    }
  }

  /** A student's own group's versions (`GET /submissions?mine=true`). */
  async mySubmissions(c: Caller) {
    const rows = await this.tx.submission.findMany({
      where: { project: { members: { some: { userId: c.userId, leftAt: null } } } },
      include: { phase: { select: { id: true, name: true, dueDate: true } }, project: { select: { id: true, title: true } } },
      orderBy: { submittedAt: 'desc' },
      take: 100,
    })
    const people = await this.core.people(rows.map((r) => r.submittedById))
    return {
      items: rows.map((r) => ({
        id: r.id, project: { id: r.project.id, name: r.project.title }, phase: { id: r.phase.id, name: r.phase.name }, version: r.version, status: r.status,
        submittedBy: people.get(r.submittedById) ?? { id: r.submittedById, name: 'Unknown' }, submittedAt: r.submittedAt, dueDate: isoDate(r.phase.dueDate), aiSummaryReady: false, approvalBlocked: false,
      })),
      nextCursor: null,
    }
  }

  /* -------------------------------- reports -------------------------------- */

  /** Scoped by Row Level Security to the projects the viewer monitors. Cached 60 s. */
  async reportSummary(c: Caller) {
    const key = `report:${c.workspaceId}:${c.userId}`
    const hit = await this.kvs.kv.get(key)
    if (hit) return JSON.parse(hit) as unknown
    const inScope = Prisma.sql`id IN (SELECT pn_content_projects())`
    const [health, status, approved, firstReview, files, comments, byDay, workload, overrides] = await Promise.all([
      this.tx.$queryRaw<{ k: string; n: bigint }[]>`SELECT health::text k, count(*) n FROM projects WHERE deleted_at IS NULL AND ${inScope} GROUP BY 1`,
      this.tx.$queryRaw<{ k: string; n: bigint }[]>`SELECT status::text k, count(*) n FROM projects WHERE deleted_at IS NULL AND ${inScope} GROUP BY 1`,
      this.tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM phases WHERE status = 'approved' AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL AND ${inScope})`,
      this.tx.$queryRaw<{ total: bigint; first: bigint }[]>`
        SELECT count(*) total, count(*) FILTER (WHERE version = 1) first FROM submissions
        WHERE status = 'approved' AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL AND ${inScope})`,
      this.tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM submission_files WHERE submission_id IN (SELECT id FROM submissions WHERE project_id IN (SELECT id FROM projects WHERE ${inScope}))`,
      this.tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM comments WHERE deleted_at IS NULL AND project_id IN (SELECT id FROM projects WHERE ${inScope})`,
      this.tx.$queryRaw<{ d: Date; n: bigint }[]>`
        SELECT g::date d, count(s.id) n FROM generate_series(current_date - 29, current_date, '1 day') g
        LEFT JOIN submissions s ON s.submitted_at::date = g::date AND s.project_id IN (SELECT id FROM projects WHERE ${inScope})
        GROUP BY 1 ORDER BY 1`,
      this.tx.$queryRaw<{ user_id: string; projects: bigint; pending: bigint; turnaround: number | null }[]>`
        WITH scope AS (SELECT id FROM projects WHERE status IN ('active','on_hold') AND deleted_at IS NULL AND ${inScope}),
        sup AS (SELECT pm.user_id, pm.project_id FROM project_members pm WHERE pm.left_at IS NULL AND pm.role IN ('lead','co_supervisor') AND pm.project_id IN (SELECT id FROM scope))
        SELECT sup.user_id,
               count(DISTINCT sup.project_id) projects,
               count(DISTINCT s.id) FILTER (WHERE s.status = 'submitted') pending,
               (SELECT avg(extract(epoch FROM (r.created_at - s2.submitted_at)) / 86400.0)
                  FROM reviews r JOIN submissions s2 ON s2.id = r.submission_id
                 WHERE r.reviewer_id = sup.user_id AND r.created_at > now() - interval '90 days' AND NOT r.is_override) turnaround
        FROM sup LEFT JOIN submissions s ON s.project_id = sup.project_id
        GROUP BY sup.user_id ORDER BY projects DESC LIMIT 100`,
      this.tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM overrides WHERE actor_is_supervisor AND project_id IN (SELECT id FROM projects WHERE ${inScope})`,
    ])
    const num = (rows: { k: string; n: bigint }[], keys: string[]) => Object.fromEntries(keys.map((k) => [k, Number(rows.find((r) => r.k === k)?.n ?? 0)]))
    const refs = await this.core.people(workload.map((w) => w.user_id))
    const total = Number(firstReview[0]?.total ?? 0)
    const out = {
      health: num(health, ['on_track', 'at_risk', 'overdue', 'awaiting_review', 'completed']),
      projectsByStatus: num(status, ['active', 'on_hold', 'completed', 'cancelled']),
      phasesApproved: Number(approved[0]?.n ?? 0),
      firstReviewApprovalRate: total ? Number(firstReview[0].first) / total : 0,
      filesUploaded: Number(files[0]?.n ?? 0),
      comments: Number(comments[0]?.n ?? 0),
      submissionsByDay: byDay.map((d) => ({ date: d.d.toISOString().slice(0, 10), submissions: Number(d.n) })),
      workload: workload.map((w) => ({
        supervisor: refs.get(w.user_id) ?? { id: w.user_id, name: 'Unknown' },
        projects: Number(w.projects),
        pendingReviews: Number(w.pending),
        avgTurnaroundDays: w.turnaround == null ? 0 : Math.round(Number(w.turnaround) * 10) / 10,
      })),
      deanOverridesOnOwnProjects: Number(overrides[0]?.n ?? 0),
    }
    await this.kvs.kv.set(key, JSON.stringify(out), 60)
    return out
  }

  /* ----------------------- supervisors overview (leaders) ----------------------- */

  async supervisorOverview(c: Caller) {
    // Supervisors in the viewer's area, with the projects they lead or co-supervise.
    const members = await this.tx.projectMember.findMany({
      where: { leftAt: null, role: { in: ['lead', 'co_supervisor'] }, project: { status: { in: ['active', 'on_hold'] }, deletedAt: null } },
      select: { userId: true, role: true, projectId: true },
    })
    const loaded = await this.core.load([...new Set(members.map((m) => m.projectId))])
    const inScope = members.filter((m) => {
      const l = loaded.get(m.projectId)
      return l && (leaderAuthority(c, l.facts) !== null || hasRole(c, 'supervision_owner'))
    })
    const summaries = new Map<string, ProjectSummaryView>()
    const ls = [...new Set(inScope.map((m) => m.projectId))].map((id) => loaded.get(id)!).filter(Boolean)
    for (const s of await this.core.summaries(c, ls)) summaries.set(s.id, s)

    const supervisorIds = [...new Set(inScope.map((m) => m.userId))]
    const [people, stats] = await Promise.all([
      this.tx.membership.findMany({
        where: { userId: { in: supervisorIds }, status: 'active' },
        include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } }, department: { select: { id: true, name: true, facultyId: true } }, roles: true },
      }),
      this.tx.$queryRaw<{ user_id: string; turnaround: number | null }[]>`
        SELECT r.reviewer_id user_id, avg(extract(epoch FROM (r.created_at - s.submitted_at)) / 86400.0) turnaround
        FROM reviews r JOIN submissions s ON s.id = r.submission_id
        WHERE r.created_at > now() - interval '90 days' AND NOT r.is_override GROUP BY 1`,
    ])
    return people
      .map((m) => {
        const mine = inScope.filter((x) => x.userId === m.userId)
        const projects = mine.map((x) => ({ ...summaries.get(x.projectId)!, roleOnProject: x.role as 'lead' | 'co_supervisor' }))
        return {
          supervisor: {
            id: m.userId, name: m.user.name, email: m.user.email, ...(m.user.avatarUrl ? { avatarUrl: m.user.avatarUrl } : {}),
            ...(m.department ? { department: { id: m.department.id, name: m.department.name } } : {}),
            canApprove: m.canApprove, status: 'active' as const, activeProjects: projects.length, titles: [] as string[],
          },
          projects,
          pendingReviews: projects.filter((p) => p.currentPhase?.status === 'submitted').length,
          avgTurnaroundDays: (() => {
            const t = stats.find((s) => s.user_id === m.userId)?.turnaround
            return t == null ? null : Math.round(Number(t) * 10) / 10
          })(),
        }
      })
      .sort((a, b) => b.projects.length - a.projects.length)
  }
}
