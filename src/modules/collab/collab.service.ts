import { Injectable } from '@nestjs/common'
import { CommentTargetType, Prisma } from '@prisma/client'
import { Caller } from '../../authz/caller'
import { actingRoleLabel, canComment, canLogTime, isSupervisorOn, projectRole, seesSupervisorOnly } from '../../authz/policy'
import { forbidden, notFound, unprocessable } from '../../common/http'
import { Db } from '../../infra/db'
import { ActivityService, NotificationService } from '../core/core.services'
import { isoDate, PersonRef, ProjectCore } from '../projects/project-core.service'
import { day } from '../projects/projects.service'

export interface CommentView {
  id: string
  author: PersonRef
  actingRole: string
  body: string
  at: Date
  target: { type: CommentTargetType; id: string; label: string }
  supervisorsOnly: boolean
  replies: Omit<CommentView, 'replies' | 'target'>[]
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

@Injectable()
export class CollabService {
  constructor(
    private db: Db,
    private core: ProjectCore,
    private activity: ActivityService,
    private notifications: NotificationService
  ) {}

  private get tx() {
    return this.db.tx
  }

  /* ------------------------------ comments ------------------------------ */

  /**
   * Supervisor-only threads are removed by Row Level Security for students:
   * even a query that forgot the filter could not return them.
   */
  async comments(c: Caller, projectId: string): Promise<CommentView[]> {
    await this.core.loadVisible(c, projectId, { phases: false })
    const rows = await this.tx.comment.findMany({ where: { projectId, deletedAt: null }, orderBy: { createdAt: 'asc' }, take: 500 })
    const people = await this.core.people(rows.map((r) => r.authorId))
    const ref = (id: string) => people.get(id) ?? { id, name: 'Unknown' }
    const top = rows.filter((r) => !r.parentId)
    return top.map((r) => ({
      id: r.id,
      author: ref(r.authorId),
      actingRole: r.actingRole,
      body: r.body,
      at: r.createdAt,
      target: { type: r.targetType, id: r.targetId, label: r.targetLabel },
      supervisorsOnly: r.supervisorsOnly,
      replies: rows
        .filter((p) => p.parentId === r.id)
        .map((p) => ({ id: p.id, author: ref(p.authorId), actingRole: p.actingRole, body: p.body, at: p.createdAt, supervisorsOnly: p.supervisorsOnly })),
    }))
  }

  async postComment(
    c: Caller,
    v: { projectId: string; body: string; supervisorsOnly?: boolean; target: { type: CommentTargetType; id: string; label?: string }; parentId?: string }
  ) {
    const x = await this.core.loadVisible(c, v.projectId)
    if (!canComment(c, x.facts)) throw forbidden('cannot_comment', 'You cannot comment on this project')
    if (x.row.status === 'cancelled') throw forbidden('project_closed', 'This project is closed')
    const body = v.body.trim()
    if (body.length < 1 || body.length > 5000) throw unprocessable('invalid_comment', 'Write between 1 and 5000 characters', [{ field: 'body', message: 'Invalid length' }])

    let supervisorsOnly = !!v.supervisorsOnly
    if (supervisorsOnly && !seesSupervisorOnly(c, x.facts)) throw forbidden('private_not_allowed', 'Only supervisors and leadership can post supervisor-only comments')

    // What the comment is attached to must belong to this project.
    let label = v.target.label?.slice(0, 120) ?? ''
    let targetId = v.target.id
    if (v.target.type === 'project') {
      targetId = x.row.id
      label ||= x.row.title
    } else if (v.target.type === 'phase') {
      const p = await this.tx.phase.findFirst({ where: { id: v.target.id, projectId: x.row.id } })
      if (!p) throw notFound('Phase')
      label ||= `Phase ${p.position} · ${p.name}`
    } else {
      const s = await this.tx.submission.findFirst({ where: { id: v.target.id, projectId: x.row.id }, include: { phase: { select: { name: true } } } })
      if (!s) throw notFound('Submission')
      label ||= `${s.phase.name} v${s.version}`
    }

    let parent: { id: string; authorId: string; supervisorsOnly: boolean; parentId: string | null } | null = null
    if (v.parentId) {
      parent = await this.tx.comment.findFirst({ where: { id: v.parentId, projectId: x.row.id, deletedAt: null }, select: { id: true, authorId: true, supervisorsOnly: true, parentId: true } })
      if (!parent || parent.parentId) throw notFound('Comment')
      supervisorsOnly = parent.supervisorsOnly // a reply never escapes a private thread
    }

    const comment = await this.tx.comment.create({
      data: {
        workspaceId: c.workspaceId!, projectId: x.row.id, authorId: c.userId, actingRole: actingRoleLabel(c, x.facts),
        body, targetType: v.target.type, targetId, targetLabel: label, parentId: parent?.id ?? null, supervisorsOnly,
      },
    })

    // @mentions: only people who may read this comment can be mentioned.
    const readers = new Set(x.facts.members.filter((m) => !supervisorsOnly || m.role !== 'student').map((m) => m.userId))
    const leaders = await this.tx.membershipRole.findMany({
      where: { OR: [{ role: 'supervision_owner' }, ...(x.facts.facultyId ? [{ role: 'dean' as const, scopeId: x.facts.facultyId }] : []), ...(x.facts.departmentId ? [{ role: 'head' as const, scopeId: x.facts.departmentId }] : [])], membership: { status: 'active' } },
      select: { membership: { select: { userId: true } } },
    })
    leaders.forEach((l) => readers.add(l.membership.userId))
    const names = await this.core.people([...readers])
    const mentioned = [...readers].filter((id) => {
      const n = names.get(id)?.name
      return n && new RegExp(`@${escapeRe(n)}(?![\\w])`, 'i').test(body) && id !== c.userId
    })
    if (mentioned.length) {
      await this.tx.commentMention.createMany({ data: mentioned.map((userId) => ({ workspaceId: c.workspaceId!, commentId: comment.id, userId })) })
      await this.notifications.notify(mentioned, { kind: 'comments', title: `${c.name} mentioned you`, body: body.slice(0, 160), link: `/projects/${x.row.id}`, data: { projectId: x.row.id, commentId: comment.id } })
    }
    if (parent && parent.authorId !== c.userId && !mentioned.includes(parent.authorId)) {
      await this.notifications.notify([parent.authorId], { kind: 'comments', title: `${c.name} replied to you`, body: body.slice(0, 160), link: `/projects/${x.row.id}`, data: { projectId: x.row.id, commentId: comment.id } })
    }
    await this.activity.record(c, x.facts, {
      category: 'collaboration',
      action: `commented on ${label}`,
      targetType: v.target.type,
      targetId,
      targetLabel: x.row.title,
      phaseId: v.target.type === 'phase' ? targetId : undefined,
      visibility: supervisorsOnly ? 'supervisors' : 'all',
    })
    return { id: comment.id }
  }

  /* ------------------------------ time logs ------------------------------ */

  async timeLogs(c: Caller, projectId: string) {
    await this.core.loadVisible(c, projectId, { phases: false })
    const rows = await this.tx.timeLog.findMany({ where: { projectId }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 200 })
    const people = await this.core.people(rows.map((r) => r.userId))
    return rows.map((r) => ({ id: r.id, person: people.get(r.userId) ?? { id: r.userId, name: 'Unknown' }, kind: r.kind, hours: Number(r.hours), note: r.note, date: isoDate(r.date)! }))
  }

  /** Students log hours; supervisors log meetings (overview). */
  async logTime(c: Caller, v: { projectId: string; kind: 'hours' | 'meeting'; hours: number; note?: string; date: string }) {
    const x = await this.core.loadVisible(c, v.projectId)
    if (!canLogTime(c, x.facts)) throw forbidden('cannot_log_time', 'Only members of this project can log time')
    const role = projectRole(c, x.facts)
    if (v.kind === 'hours' && role !== 'student') throw forbidden('hours_are_for_students', 'Students log hours; supervisors log meetings')
    if (v.kind === 'meeting' && !isSupervisorOn(c, x.facts)) throw forbidden('meetings_are_for_supervisors', 'Supervisors log meetings')
    if (!(v.hours > 0 && v.hours <= 24)) throw unprocessable('invalid_hours', 'Enter between 0 and 24 hours', [{ field: 'hours', message: 'Out of range' }])
    const d = day(v.date)
    if (d.getTime() > Date.now() + 86_400_000) throw unprocessable('invalid_date', 'The date cannot be in the future', [{ field: 'date', message: 'In the future' }])
    const log = await this.tx.timeLog.create({
      data: { workspaceId: c.workspaceId!, projectId: x.row.id, userId: c.userId, kind: v.kind, hours: new Prisma.Decimal(v.hours), note: (v.note ?? '').slice(0, 500), date: d },
    })
    await this.activity.record(c, x.facts, {
      category: 'time',
      action: v.kind === 'meeting' ? `logged a ${v.hours}h meeting` : `logged ${v.hours}h`,
      targetType: 'project', targetId: x.row.id, targetLabel: x.row.title,
      after: v.note?.slice(0, 120),
    })
    return { id: log.id }
  }
}
