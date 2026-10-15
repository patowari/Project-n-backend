import { Injectable } from '@nestjs/common'
import { Caller, hasRole } from '../../authz/caller'
import { approvalBlocked, canManageProject, canOverride, projectRole } from '../../authz/policy'
import { conflict, forbidden, notFound, unprocessable } from '../../common/http'
import { Db } from '../../infra/db'
import { ActivityService, AuditService, JobsService, NotificationService } from '../core/core.services'
import { LoadedProject, PersonRef, ProjectCore } from '../projects/project-core.service'
import { OrgService } from '../org/org.service'
import { reasonFor } from '../projects/projects.service'
import { WorkflowService } from '../workflow/workflow.service'

const MIN_REASON = 3

export interface OffboardPlanItem {
  project: { id: string; name: string }
  role: 'lead' | 'co_supervisor'
  effect: 'successor_becomes_lead' | 'needs_supervisor' | 'removed'
  successor: PersonRef | null
}

@Injectable()
export class GovernanceService {
  constructor(
    private db: Db,
    private core: ProjectCore,
    private org: OrgService,
    private workflow: WorkflowService,
    private activity: ActivityService,
    private audit: AuditService,
    private jobs: JobsService,
    private notifications: NotificationService
  ) {}

  private get tx() {
    return this.db.tx
  }

  /* ---------------------- approval-right revocations ---------------------- */

  /** Who may revoke or restore: the Admin, the Dean of the faculty, the Owner (5.4, 5.8). */
  private async assertCanGovern(c: Caller, scope: { facultyId?: string | null; project?: LoadedProject }) {
    if (hasRole(c, 'institution_admin', 'supervision_owner')) return
    if (hasRole(c, 'dean')) {
      const mine = c.grants.filter((g) => g.role === 'dean').map((g) => g.scopeId)
      const faculty = scope.project?.facts.facultyId ?? scope.facultyId
      if (faculty && mine.includes(faculty)) return
    }
    throw forbidden('cannot_govern', 'Only the Institution Admin or the Dean of the faculty can change approval rights')
  }

  async revoke(c: Caller, userId: string, v: { scope: 'project' | 'faculty'; projectId?: string; facultyId?: string; reason: string }) {
    const reason = v.reason?.trim() ?? ''
    if (reason.length < MIN_REASON) throw unprocessable('reason_required', 'A reason is required', [{ field: 'reason', message: 'Required' }])
    const member = await this.tx.membership.findFirst({ where: { userId, status: 'active', roles: { some: { role: 'supervisor' } } } })
    if (!member) throw notFound('Supervisor')

    let facultyId: string | null = null
    let project: LoadedProject | undefined
    if (v.scope === 'project') {
      if (!v.projectId) throw unprocessable('project_required', 'Choose the project', [{ field: 'projectId', message: 'Required' }])
      project = await this.core.loadVisible(c, v.projectId, { phases: false })
      facultyId = project.facts.facultyId
      if (!project.facts.members.some((m) => m.userId === userId && m.role !== 'student')) throw unprocessable('not_on_project', 'That supervisor is not on this project')
    } else {
      if (c.workspaceType === 'supervision') throw unprocessable('no_faculties', 'Supervision workspaces have no faculties; revoke per project')
      if (!v.facultyId) throw unprocessable('faculty_required', 'Choose the faculty', [{ field: 'facultyId', message: 'Required' }])
      facultyId = v.facultyId
    }
    await this.assertCanGovern(c, { facultyId, project })

    const rev = await this.tx.approvalRevocation.create({
      data: { workspaceId: c.workspaceId!, userId, scope: v.scope, projectId: v.scope === 'project' ? v.projectId : null, facultyId: v.scope === 'faculty' ? facultyId : null, reason, revokedById: c.userId },
    })
    await this.afterRightsChange(c, userId, v.scope === 'project' ? project : undefined, facultyId, {
      action: `revoked ${(await this.core.people([userId])).get(userId)?.name ?? 'a supervisor'}'s approval right${v.scope === 'faculty' ? ' in the faculty' : ''}`,
      reason,
    })
    await this.audit.log('governance.approval_revoked', { actorId: c.userId, targetType: 'user', targetId: userId, data: { scope: v.scope, revocationId: rev.id } })
    return { id: rev.id }
  }

  async restore(c: Caller, revocationId: string, reason: string) {
    const r = await this.tx.approvalRevocation.findFirst({ where: { id: revocationId, restoredAt: null } })
    if (!r) throw notFound('Revocation')
    if ((reason?.trim() ?? '').length < MIN_REASON) throw unprocessable('reason_required', 'A reason is required', [{ field: 'reason', message: 'Required' }])
    const project = r.projectId ? await this.core.loadVisible(c, r.projectId, { phases: false }) : undefined
    await this.assertCanGovern(c, { facultyId: r.facultyId, project })
    await this.tx.approvalRevocation.update({ where: { id: r.id }, data: { restoredAt: new Date(), restoredById: c.userId, restoreReason: reason.trim() } })
    await this.afterRightsChange(c, r.userId, project, r.facultyId, {
      action: `restored ${(await this.core.people([r.userId])).get(r.userId)?.name ?? 'a supervisor'}'s approval right`,
      reason: reason.trim(),
    })
    await this.audit.log('governance.approval_restored', { actorId: c.userId, targetType: 'user', targetId: r.userId, data: { revocationId } })
  }

  async revocations(c: Caller, userId: string) {
    if (userId !== c.userId && !hasRole(c, 'institution_admin', 'supervision_owner', 'dean', 'head')) throw forbidden()
    const rows = await this.tx.approvalRevocation.findMany({ where: { userId }, orderBy: { revokedAt: 'desc' }, take: 100 })
    const people = await this.core.people(rows.flatMap((r) => [r.revokedById, ...(r.restoredById ? [r.restoredById] : [])]))
    return rows.map((r) => ({
      id: r.id, scope: r.scope, projectId: r.projectId, facultyId: r.facultyId, reason: r.reason, revokedAt: r.revokedAt,
      revokedBy: people.get(r.revokedById) ?? null, restoredAt: r.restoredAt, restoredBy: r.restoredById ? (people.get(r.restoredById) ?? null) : null, restoreReason: r.restoreReason,
    }))
  }

  /** Log, tell the supervisor, and alert leadership about projects that just became blocked (5.4). */
  private async afterRightsChange(c: Caller, userId: string, project: LoadedProject | undefined, facultyId: string | null, e: { action: string; reason: string }) {
    const affectedIds = project
      ? [project.row.id]
      : (await this.tx.projectMember.findMany({ where: { userId, leftAt: null, role: { in: ['lead', 'co_supervisor'] }, project: { status: 'active', deletedAt: null, ...(facultyId ? { department: { facultyId } } : {}) } }, select: { projectId: true } })).map((m) => m.projectId)
    const loaded = await this.core.load(affectedIds, { phases: false })
    for (const l of loaded.values()) {
      await this.activity.record(c, l.facts, {
        category: 'governance', action: e.action, targetType: 'user', targetId: userId, targetLabel: l.row.title, reason: e.reason, isOverride: canOverride(c, l.facts), visibility: 'supervisors',
      })
      if (l.row.status === 'active' && approvalBlocked(l.facts)) {
        const to = await this.workflow.leadership(l, { admins: true })
        await this.notifications.notify(to, { kind: 'escalations', title: `Approval blocked on “${l.row.title}”`, body: 'No supervisor on this project can approve phases.', link: `/projects/${l.row.id}` }, { exclude: c.userId })
      }
    }
    if (affectedIds.length === 0) await this.activity.record(c, null, { category: 'governance', action: e.action, targetType: 'user', targetId: userId, reason: e.reason, visibility: 'supervisors' })
    await this.notifications.notify([userId], { kind: 'people', title: e.action.charAt(0).toUpperCase() + e.action.slice(1), body: e.reason })
    await this.jobs.enqueue('governance.reassign_queue', { userId, workspaceId: c.workspaceId })
  }

  /* ------------------------------- succession ------------------------------- */

  private pickSuccessor(l: LoadedProject, leaving: string, explicit?: string) {
    const cos = l.facts.members.filter((m) => m.role === 'co_supervisor' && m.userId !== leaving)
    if (explicit) return cos.find((m) => m.userId === explicit) ?? null
    return cos.find((m) => m.isSuccessor) ?? [...cos].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0] ?? null
  }

  private async assertCanOffboard(c: Caller, userId: string) {
    if (hasRole(c, 'institution_admin', 'supervision_owner')) return
    if (hasRole(c, 'dean')) {
      const m = await this.tx.membership.findFirst({ where: { userId }, include: { department: { select: { facultyId: true } } } })
      const mine = c.grants.filter((g) => g.role === 'dean').map((g) => g.scopeId)
      if (m?.department && mine.includes(m.department.facultyId)) return
    }
    throw forbidden('cannot_offboard', 'Only the Institution Admin or the Dean of their faculty can offboard a supervisor')
  }

  /** One screen: every affected project with the proposed successor. */
  async offboardPreview(c: Caller, userId: string): Promise<OffboardPlanItem[]> {
    await this.assertCanOffboard(c, userId)
    const rows = await this.tx.projectMember.findMany({
      where: { userId, leftAt: null, role: { in: ['lead', 'co_supervisor'] }, project: { status: { in: ['active', 'on_hold'] }, deletedAt: null } },
      select: { projectId: true, role: true },
    })
    const loaded = await this.core.load(rows.map((r) => r.projectId), { phases: false })
    const out: OffboardPlanItem[] = []
    for (const r of rows) {
      const l = loaded.get(r.projectId)
      if (!l) continue
      if (r.role === 'co_supervisor') {
        out.push({ project: { id: l.row.id, name: l.row.title }, role: 'co_supervisor', effect: 'removed', successor: null })
        continue
      }
      const s = this.pickSuccessor(l, userId)
      const ref = s ? ((await this.core.people([s.userId])).get(s.userId) ?? null) : null
      out.push({ project: { id: l.row.id, name: l.row.title }, role: 'lead', effect: s ? 'successor_becomes_lead' : 'needs_supervisor', successor: ref })
    }
    return out
  }

  /**
   * Hands every project over, then deactivates the person. Pending reviews,
   * approvals and extension requests follow automatically: they are derived
   * from who is Lead / Co-supervisor, not copied (5.6).
   */
  async offboard(c: Caller, userId: string, v: { reason: string; assignments?: { projectId: string; successorId: string }[] }) {
    await this.assertCanOffboard(c, userId)
    const reason = v.reason?.trim() ?? ''
    if (reason.length < MIN_REASON) throw unprocessable('reason_required', 'A reason is required', [{ field: 'reason', message: 'Required' }])
    const rows = await this.tx.projectMember.findMany({
      where: { userId, leftAt: null, role: { in: ['lead', 'co_supervisor'] }, project: { status: { in: ['active', 'on_hold'] }, deletedAt: null } },
      select: { projectId: true, role: true },
    })
    const ids = rows.map((r) => r.projectId).sort() // fixed lock order
    for (const id of ids) await this.db.lock('projects', id)
    const loaded = await this.core.load(ids, { phases: false })
    const who = (await this.core.people([userId])).get(userId)?.name ?? 'a supervisor'
    const explicit = new Map((v.assignments ?? []).map((a) => [a.projectId, a.successorId]))
    const summary: OffboardPlanItem[] = []

    for (const id of ids) {
      const l = loaded.get(id)
      if (!l) continue
      const mine = l.facts.members.find((m) => m.userId === userId)!
      await this.tx.projectMember.updateMany({ where: { projectId: id, userId, leftAt: null }, data: { leftAt: new Date(), leftReason: 'offboarded', isSuccessor: false } })
      if (mine.role === 'co_supervisor') {
        await this.activity.record(c, l.facts, { category: 'people', action: `removed ${who} (offboarded)`, targetType: 'project', targetId: id, targetLabel: l.row.title, reason })
        summary.push({ project: { id, name: l.row.title }, role: 'co_supervisor', effect: 'removed', successor: null })
        continue
      }
      const asked = explicit.get(id)
      const s = this.pickSuccessor(l, userId, asked)
      if (asked && !s) throw unprocessable('invalid_successor', 'The successor must be a co-supervisor on that project', [{ field: 'assignments', message: l.row.title }])
      if (s) {
        await this.tx.projectMember.updateMany({ where: { projectId: id, userId: s.userId, leftAt: null }, data: { role: 'lead', isSuccessor: false } })
        await this.tx.project.update({ where: { id }, data: { needsSupervisor: false, version: { increment: 1 } } })
        const ref = (await this.core.people([s.userId])).get(s.userId) ?? null
        await this.activity.record(c, l.facts, { category: 'people', action: `changed the Lead supervisor (${who} offboarded)`, targetType: 'project', targetId: id, targetLabel: l.row.title, before: who, after: ref?.name ?? '', reason, isOverride: canOverride(c, l.facts) })
        await this.notifications.notify([s.userId], { kind: 'people', title: `You are now Lead supervisor of “${l.row.title}”`, body: 'Connect Google Drive so new submissions go to your Drive.', link: `/projects/${id}` })
        await this.notifications.notify(await this.workflow.leadership(l), { kind: 'people', title: `New Lead on “${l.row.title}”`, body: `${ref?.name ?? 'A co-supervisor'} replaces ${who}.`, link: `/projects/${id}` }, { exclude: c.userId })
        await this.jobs.enqueue('drive.sync_permissions', { projectId: id }, { dedupeKey: `drive-sync:${id}:${Date.now()}` })
        summary.push({ project: { id, name: l.row.title }, role: 'lead', effect: 'successor_becomes_lead', successor: ref })
      } else {
        await this.tx.project.update({ where: { id }, data: { needsSupervisor: true, version: { increment: 1 } } })
        await this.activity.record(c, l.facts, { category: 'people', action: `${who} left; the project needs a supervisor`, targetType: 'project', targetId: id, targetLabel: l.row.title, reason })
        await this.notifications.notify(await this.workflow.leadership(l, { admins: true }), { kind: 'escalations', title: `“${l.row.title}” needs a supervisor`, body: 'Assign a new Lead. A Dean can approve phases in the meantime.', link: `/projects/${id}` }, { exclude: c.userId })
        summary.push({ project: { id, name: l.row.title }, role: 'lead', effect: 'needs_supervisor', successor: null })
      }
      await this.jobs.healthRecompute(id)
    }
    await this.tx.membership.updateMany({ where: { userId, status: 'active' }, data: { status: 'deactivated' } })
    await this.activity.record(c, null, { category: 'people', action: `offboarded ${who}`, targetType: 'user', targetId: userId, reason })
    await this.audit.log('governance.offboarded', { actorId: c.userId, targetType: 'user', targetId: userId, data: { projects: summary.length, reason } })
    return summary
  }

  /** Assign (or swap) the Lead. The previous Lead stays on as co-supervisor. */
  async assignLead(c: Caller, projectId: string, v: { userId: string; reason?: string }) {
    await this.db.lock('projects', projectId)
    const l = await this.core.loadVisible(c, projectId, { phases: false })
    const adminOk = hasRole(c, 'institution_admin')
    if (!canOverride(c, l.facts) && !adminOk) throw forbidden('cannot_assign_lead', 'Only the Dean, the Owner or the Institution Admin assigns the Lead')
    const reason = (v.reason ?? '').trim()
    if (!adminOk && reason.length < MIN_REASON) throw unprocessable('reason_required', 'A reason is required', [{ field: 'reason', message: 'Required' }])
    if (l.row.status === 'completed' || l.row.status === 'cancelled') throw conflict('project_closed', 'This project is closed')

    const target = await this.tx.membership.findFirst({ where: { userId: v.userId, status: 'active', roles: { some: { role: 'supervisor' } } } })
    if (!target) throw unprocessable('invalid_member', 'Choose an active supervisor', [{ field: 'userId', message: 'Not a supervisor' }])
    const current = l.facts.members.find((m) => m.role === 'lead')
    if (current?.userId === v.userId) return
    const existing = l.facts.members.find((m) => m.userId === v.userId)
    if (existing?.role === 'student') throw unprocessable('invalid_member', 'A student cannot lead the project')

    if (current) await this.tx.projectMember.updateMany({ where: { projectId, userId: current.userId, leftAt: null }, data: { role: 'co_supervisor' } })
    if (existing) await this.tx.projectMember.updateMany({ where: { projectId, userId: v.userId, leftAt: null }, data: { role: 'lead', isSuccessor: false } })
    else await this.tx.projectMember.create({ data: { workspaceId: c.workspaceId!, projectId, userId: v.userId, role: 'lead' } })
    await this.tx.project.update({ where: { id: projectId }, data: { needsSupervisor: false, version: { increment: 1 } } })

    const refs = await this.core.people([v.userId, ...(current ? [current.userId] : [])])
    await this.activity.record(c, l.facts, {
      category: 'people', action: 'changed the Lead supervisor', targetType: 'project', targetId: projectId, targetLabel: l.row.title,
      before: current ? (refs.get(current.userId)?.name ?? '') : 'none', after: refs.get(v.userId)?.name ?? '', reason: reason || undefined, isOverride: canOverride(c, l.facts),
    })
    await this.notifications.notify([v.userId], { kind: 'people', title: `You are now Lead supervisor of “${l.row.title}”`, body: 'Connect Google Drive so new submissions go to your Drive.', link: `/projects/${projectId}` }, { exclude: c.userId })
    await this.jobs.enqueue('drive.sync_permissions', { projectId }, { dedupeKey: `drive-sync:${projectId}:${Date.now()}` })
    await this.jobs.healthRecompute(projectId)
  }

  async setSuccessor(c: Caller, projectId: string, userId: string | null) {
    await this.db.lock('projects', projectId)
    const l = await this.core.loadVisible(c, projectId, { phases: false })
    if (!canManageProject(c, l.facts)) throw forbidden('cannot_set_successor', 'Only the Lead or the Dean designates a successor')
    if (userId && !l.facts.members.some((m) => m.userId === userId && m.role === 'co_supervisor')) throw unprocessable('invalid_successor', 'The successor must be a co-supervisor', [{ field: 'userId', message: 'Not a co-supervisor' }])
    await this.tx.projectMember.updateMany({ where: { projectId, isSuccessor: true, leftAt: null }, data: { isSuccessor: false } })
    if (userId) await this.tx.projectMember.updateMany({ where: { projectId, userId, leftAt: null }, data: { isSuccessor: true } })
    const name = userId ? ((await this.core.people([userId])).get(userId)?.name ?? '') : 'none'
    await this.activity.record(c, l.facts, { category: 'people', action: 'designated a successor co-supervisor', targetType: 'project', targetId: projectId, targetLabel: l.row.title, after: name })
  }

  /** Co-supervisors: Lead, Dean/Owner or the Institution Admin (assignments are their job). */
  async addCoSupervisor(c: Caller, projectId: string, userId: string, reason?: string) {
    await this.db.lock('projects', projectId)
    const l = await this.core.loadVisible(c, projectId, { phases: false })
    if (!canManageProject(c, l.facts) && !hasRole(c, 'institution_admin')) throw forbidden('cannot_manage_supervisors')
    const target = await this.tx.membership.findFirst({ where: { userId, status: 'active', roles: { some: { role: 'supervisor' } } } })
    if (!target) throw unprocessable('invalid_member', 'Choose an active supervisor')
    if (l.facts.members.some((m) => m.userId === userId)) throw conflict('already_on_project', 'That person is already on the project')
    await this.tx.projectMember.create({ data: { workspaceId: c.workspaceId!, projectId, userId, role: 'co_supervisor' } })
    const name = (await this.core.people([userId])).get(userId)?.name ?? ''
    await this.activity.record(c, l.facts, { category: 'people', action: `added ${name} as co-supervisor`, targetType: 'project', targetId: projectId, targetLabel: l.row.title, reason: reason || undefined })
    await this.notifications.notify([userId], { kind: 'people', title: `You were added to “${l.row.title}”`, link: `/projects/${projectId}` }, { exclude: c.userId })
    await this.jobs.enqueue('drive.sync_permissions', { projectId }, { dedupeKey: `drive-sync:${projectId}:${Date.now()}` })
  }

  async removeCoSupervisor(c: Caller, projectId: string, userId: string, reason?: string) {
    await this.db.lock('projects', projectId)
    const l = await this.core.loadVisible(c, projectId, { phases: false })
    if (!canManageProject(c, l.facts) && !hasRole(c, 'institution_admin')) throw forbidden('cannot_manage_supervisors')
    const why = reasonFor(c, l.facts, reason, false)
    const m = l.facts.members.find((x) => x.userId === userId && x.role === 'co_supervisor')
    if (!m) throw notFound('Co-supervisor')
    await this.tx.projectMember.updateMany({ where: { projectId, userId, leftAt: null }, data: { leftAt: new Date(), leftReason: why ?? 'removed', isSuccessor: false } })
    const name = (await this.core.people([userId])).get(userId)?.name ?? ''
    await this.activity.record(c, l.facts, { category: 'people', action: `removed ${name} as co-supervisor`, targetType: 'project', targetId: projectId, targetLabel: l.row.title, reason: why, isOverride: !!why && projectRole(c, l.facts) !== 'lead' })
    await this.jobs.enqueue('drive.sync_permissions', { projectId }, { dedupeKey: `drive-sync:${projectId}:${Date.now()}` })
  }
}
