import { Injectable } from '@nestjs/common'
import { Prisma, ProjectHealth, ProjectStatus, SubmissionMode, UnlockRule } from '@prisma/client'
import { Caller, hasRole } from '../../authz/caller'
import {
  actingRoleLabel,
  approvalBlocked,
  canApprove,
  canComment,
  canLogTime,
  canManageProject,
  canOverride,
  canRequestExtension,
  canReview,
  canSubmit,
  canUpload,
  canViewContent,
  leaderAuthority,
  phaseApprovers,
  ProjectFacts,
  projectRole,
  seesSupervisorOnly,
} from '../../authz/policy'
import {
  ApiError,
  clampLimit,
  conflict,
  decodeCursor,
  forbidden,
  notFound,
  toPage,
  unprocessable,
} from '../../common/http'
import { Db } from '../../infra/db'
import { ActivityService, AuditService, JobsService, NotificationService } from '../core/core.services'
import { OrgService } from '../org/org.service'
import { isoDate, LoadedProject, ProjectCore, ProjectSummaryView } from './project-core.service'

export interface ProjectFilters {
  scope?: 'mine' | 'all'
  health?: ProjectHealth[]
  status?: ProjectStatus[]
  q?: string
  cursor?: string
  limit?: number
}

export interface CreateProjectInput {
  title: string
  description?: string
  departmentId: string | null
  startDate: string
  phases: { name: string; dueDate: string | null }[]
  unlockRule: UnlockRule
  leadId: string
  coSupervisorIds: string[]
  successorId: string | null
  studentIds: string[]
  groupLeaderId: string | null
  submissionMode: SubmissionMode
  aiStudentFeedback: boolean
  aiSupervisorSummary: boolean
}

export const day = (s: string) => new Date(`${s}T00:00:00.000Z`)
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Dean/Owner acting on someone else's project must say why (architecture 5.5). */
export function reasonFor(c: Caller, facts: ProjectFacts, reason: string | undefined, asLead = true): string | null {
  const isLead = projectRole(c, facts) === 'lead'
  const overriding = !isLead && (canOverride(c, facts) || !asLead)
  if (!overriding) return reason?.trim() || null
  const r = reason?.trim() ?? ''
  if (r.length < 3) throw unprocessable('reason_required', 'A short reason is required for this change', [{ field: 'reason', message: 'Required' }])
  return r
}

@Injectable()
export class ProjectsService {
  constructor(
    private db: Db,
    private core: ProjectCore,
    private org: OrgService,
    private activity: ActivityService,
    private audit: AuditService,
    private jobs: JobsService,
    private notifications: NotificationService
  ) {}

  private get tx() {
    return this.db.tx
  }

  /* ------------------------------ list ------------------------------ */

  async list(c: Caller, f: ProjectFilters) {
    const limit = clampLimit(f.limit)
    const cur = decodeCursor(f.cursor)
    const where: Prisma.ProjectWhereInput = {
      deletedAt: null,
      ...(f.health?.length ? { health: { in: f.health } } : {}),
      ...(f.status?.length ? { status: { in: f.status } } : {}),
      ...(f.q ? { title: { contains: f.q.slice(0, 100), mode: 'insensitive' } } : {}),
      ...(f.scope === 'mine' ? { members: { some: { userId: c.userId, leftAt: null } } } : {}),
      ...(cur
        ? { OR: [{ createdAt: { lt: new Date(cur.t) } }, { createdAt: new Date(cur.t), id: { lt: cur.id } }] }
        : {}),
    }
    const rows = await this.tx.project.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: { id: true, createdAt: true },
    })
    const page = toPage(rows, limit, (r) => r.createdAt)
    const loaded = await this.core.load(page.items.map((r) => r.id))
    const ordered = page.items.map((r) => loaded.get(r.id)).filter((x): x is LoadedProject => !!x)
    return { items: await this.core.summaries(c, ordered), nextCursor: page.nextCursor }
  }

  /* ----------------------------- create ----------------------------- */

  async create(c: Caller, v: CreateProjectInput): Promise<ProjectSummaryView> {
    const ws = await this.tx.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: c.workspaceId! } })
    const isCreatorRole = hasRole(c, 'dean', 'supervision_owner') || (hasRole(c, 'supervisor') && ws.supervisorsCanCreateProjects)
    if (!isCreatorRole) throw forbidden('cannot_create_projects', 'Your role cannot create projects in this workspace')

    this.validateCreate(c, v)
    const institution = c.workspaceType === 'institution'
    if (institution) {
      if (!v.departmentId) throw unprocessable('department_required', 'Choose the department this project belongs to', [{ field: 'departmentId', message: 'Required' }])
      await this.org.assertDepartmentInScope(c, v.departmentId)
    } else if (v.departmentId) {
      throw unprocessable('department_not_allowed', 'Supervision workspaces have no departments')
    }

    const everyone = [v.leadId, ...v.coSupervisorIds, ...v.studentIds]
    if (new Set(everyone).size !== everyone.length) throw unprocessable('duplicate_member', 'A person can only have one role on a project')
    const people = await this.tx.membership.findMany({
      where: { userId: { in: everyone }, status: 'active' },
      include: { roles: true },
    })
    const byId = new Map(people.map((p) => [p.userId, p]))
    const need = (id: string, role: 'supervisor' | 'student', field: string) => {
      const m = byId.get(id)
      if (!m || !m.roles.some((r) => r.role === role)) {
        throw unprocessable('invalid_member', `Not an active ${role} in this workspace`, [{ field, message: `Choose an active ${role}` }])
      }
    }
    need(v.leadId, 'supervisor', 'leadId')
    v.coSupervisorIds.forEach((id) => need(id, 'supervisor', 'coSupervisorIds'))
    v.studentIds.forEach((id) => need(id, 'student', 'studentIds'))
    if (institution && !hasRole(c, 'institution_admin')) {
      const allowed = await this.org.departmentIdsIn(await this.org.scope(c))
      if (allowed && !everyone.every((id) => !!byId.get(id)?.departmentId && allowed.includes(byId.get(id)!.departmentId!))) {
        throw forbidden('out_of_scope', 'Everyone on the project must belong to your area')
      }
    }

    const project = await this.tx.project.create({
      data: {
        workspaceId: c.workspaceId!,
        title: v.title.trim(),
        description: v.description?.trim() ?? '',
        departmentId: v.departmentId,
        startDate: day(v.startDate),
        unlockRule: v.unlockRule,
        submissionMode: v.submissionMode,
        aiStudentFeedback: v.aiStudentFeedback,
        aiSupervisorSummary: v.aiSupervisorSummary,
        createdById: c.userId,
      },
    })
    await this.tx.projectMember.createMany({
      data: [
        { role: 'lead' as const, userId: v.leadId, isGroupLeader: false, isSuccessor: false },
        ...v.coSupervisorIds.map((userId) => ({ role: 'co_supervisor' as const, userId, isGroupLeader: false, isSuccessor: userId === v.successorId })),
        ...v.studentIds.map((userId) => ({ role: 'student' as const, userId, isGroupLeader: userId === v.groupLeaderId, isSuccessor: false })),
      ].map((m) => ({ ...m, workspaceId: c.workspaceId!, projectId: project.id })),
    })
    await this.tx.phase.createMany({
      data: v.phases.map((p, i) => ({
        workspaceId: c.workspaceId!,
        projectId: project.id,
        position: i + 1,
        name: p.name.trim(),
        dueDate: p.dueDate ? day(p.dueDate) : null,
        status: i === 0 ? ('open' as const) : ('locked' as const),
      })),
    })

    const loaded = (await this.core.load([project.id])).get(project.id)!
    await this.activity.record(c, loaded.facts, {
      category: 'project',
      action: 'created the project',
      targetType: 'project',
      targetId: project.id,
      targetLabel: project.title,
    })
    await this.notifications.notify(
      [v.leadId, ...v.coSupervisorIds, ...v.studentIds],
      { kind: 'people', title: `You were added to “${project.title}”`, link: `/projects/${project.id}`, data: { projectId: project.id } },
      { exclude: c.userId }
    )
    await this.jobs.healthRecompute(project.id)
    await this.jobs.enqueue('drive.sync_permissions', { projectId: project.id }, { dedupeKey: `drive-sync:${project.id}:create` })
    await this.audit.log('project.created', { actorId: c.userId, targetType: 'project', targetId: project.id })
    return (await this.core.summaries(c, [loaded]))[0]
  }

  private validateCreate(c: Caller, v: CreateProjectInput) {
    const errs: { field: string; message: string }[] = []
    if (!DAY_RE.test(v.startDate)) errs.push({ field: 'startDate', message: 'Use YYYY-MM-DD' })
    if (v.phases.length === 0 || v.phases.length > 30) errs.push({ field: 'phases', message: 'Add 1 to 30 phases' })
    let prev = v.startDate
    v.phases.forEach((p, i) => {
      if (p.dueDate === null) return
      if (!DAY_RE.test(p.dueDate)) errs.push({ field: `phases.${i}.dueDate`, message: 'Use YYYY-MM-DD' })
      else if (p.dueDate <= prev) errs.push({ field: `phases.${i}.dueDate`, message: i === 0 ? 'Must be after the start date' : 'Must be after the previous phase' })
      else prev = p.dueDate
    })
    if (v.successorId && !v.coSupervisorIds.includes(v.successorId)) errs.push({ field: 'successorId', message: 'The successor must be one of the co-supervisors' })
    if (v.studentIds.length > 1 && !v.groupLeaderId) errs.push({ field: 'groupLeaderId', message: 'A group of two or more needs a group leader' })
    if (v.groupLeaderId && !v.studentIds.includes(v.groupLeaderId)) errs.push({ field: 'groupLeaderId', message: 'The group leader must be in the group' })
    if (errs.length) throw unprocessable('validation_failed', 'One or more fields are invalid', errs)
    void c
  }

  /* ------------------------------ detail ------------------------------ */

  capabilities(c: Caller, f: ProjectFacts) {
    const content = canViewContent(c, f)
    return {
      seesContent: content,
      seesSupervisorOnly: seesSupervisorOnly(c, f),
      canComment: canComment(c, f),
      canReview: canReview(c, f),
      canApprove: canApprove(c, f),
      canSubmit: canSubmit(c, f),
      canUpload: canUpload(c, f),
      canRequestExtension: canRequestExtension(c, f),
      canLogTime: canLogTime(c, f),
      canOverride: canOverride(c, f),
      canManageGroup: canManageProject(c, f),
      canEditTimeline: canManageProject(c, f),
    }
  }

  async detail(c: Caller, id: string) {
    const loaded = await this.core.loadVisible(c, id)
    const { row, facts } = loaded
    const [summary] = await this.core.summaries(c, [loaded])
    const content = canViewContent(c, facts)

    const phases = content
      ? await this.tx.phase.findMany({
          where: { projectId: id },
          orderBy: { position: 'asc' },
          include: { requirements: { orderBy: { position: 'asc' } }, resources: { orderBy: { addedAt: 'asc' } } },
        })
      : []
    const pendingExt = content
      ? await this.tx.extensionRequest.findMany({ where: { projectId: id, status: 'pending' }, select: { phaseId: true } })
      : []
    const refs = await this.core.people([
      ...facts.members.map((m) => m.userId),
      ...phases.flatMap((p) => [...(p.approvedById ? [p.approvedById] : []), ...p.resources.map((r) => r.addedById)]),
    ])
    const ref = (uid: string) => refs.get(uid) ?? { id: uid, name: 'Unknown' }
    const emails = content
      ? new Map((await this.tx.user.findMany({ where: { id: { in: facts.members.map((m) => m.userId) } }, select: { id: true, email: true } })).map((u) => [u.id, u.email]))
      : new Map<string, string>()

    return {
      ...summary,
      description: content ? row.description : '',
      startDate: isoDate(row.startDate)!,
      unlockRule: row.unlockRule,
      submissionMode: row.submissionMode,
      aiStudentFeedback: row.aiStudentFeedback,
      aiSupervisorSummary: row.aiSupervisorSummary,
      phases: phases.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        requirements: p.requirements.map((r) => ({ id: r.id, name: r.name, optional: r.optional })),
        resources: p.resources.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind as 'file' | 'link',
          url: r.url,
          ...(r.sizeKb != null ? { sizeKb: r.sizeKb } : {}),
          addedBy: ref(r.addedById),
          addedAt: r.addedAt,
        })),
        index: p.position,
        status: p.status,
        dueDate: isoDate(p.dueDate),
        latestVersion: p.latestVersion > 0 ? p.latestVersion : null,
        approvedAt: p.approvedAt,
        approvedBy: p.approvedById ? ref(p.approvedById) : null,
        extensionPending: pendingExt.some((e) => e.phaseId === p.id),
      })),
      supervisors: facts.members
        .filter((m) => m.role !== 'student')
        .map((m) => ({
          ...ref(m.userId),
          ...(emails.get(m.userId) ? { email: emails.get(m.userId) } : {}),
          role: m.role as 'lead' | 'co_supervisor',
          canApprove: !!facts.approvalRights.get(m.userId),
          isSuccessor: m.isSuccessor,
        })),
      driveFolderUrl: content ? row.driveFolderUrl : null,
      viewer: this.capabilities(c, facts),
      version: row.version,
    }
  }

  /* ------------------------------ edits ------------------------------ */

  /** `PATCH /projects/{id}`: optimistic concurrency through If-Match. */
  async patch(c: Caller, id: string, v: { title?: string; description?: string; submissionMode?: SubmissionMode; reason?: string }, ifMatch?: string) {
    await this.db.lock('projects', id)
    const { row, facts } = await this.core.loadVisible(c, id, { phases: false })
    if (!canManageProject(c, facts)) throw forbidden('cannot_edit_project')
    if (ifMatch) {
      const want = Number(ifMatch.replace(/[^0-9]/g, ''))
      if (!Number.isInteger(want) || want !== row.version) {
        throw new ApiError(412, 'version_mismatch', 'The project was changed by someone else. Reload and try again')
      }
    }
    const reason = reasonFor(c, facts, v.reason)
    const data: Prisma.ProjectUpdateInput = { version: { increment: 1 } }
    const changes: string[] = []
    if (v.title !== undefined && v.title.trim() !== row.title) {
      data.title = v.title.trim()
      changes.push('title')
    }
    if (v.description !== undefined && v.description !== row.description) {
      data.description = v.description
      changes.push('description')
    }
    if (v.submissionMode && v.submissionMode !== row.submissionMode) {
      data.submissionMode = v.submissionMode
      changes.push('submission mode')
    }
    if (changes.length === 0) return { version: row.version }
    const updated = await this.tx.project.update({ where: { id }, data })
    await this.activity.record(c, facts, {
      category: v.submissionMode && v.submissionMode !== row.submissionMode ? 'people' : 'project',
      action: `changed ${changes.join(', ')}`,
      targetType: 'project',
      targetId: id,
      targetLabel: updated.title,
      before: v.submissionMode && v.submissionMode !== row.submissionMode ? row.submissionMode : undefined,
      after: v.submissionMode && v.submissionMode !== row.submissionMode ? v.submissionMode : undefined,
      reason,
      isOverride: !!reason && projectRole(c, facts) !== 'lead',
    })
    return { version: updated.version }
  }

  /* ----------------------- students and group leader ----------------------- */

  private async assertGroupManager(c: Caller, id: string) {
    await this.db.lock('projects', id)
    const loaded = await this.core.loadVisible(c, id, { phases: false })
    if (!canManageProject(c, loaded.facts)) throw forbidden('cannot_manage_group', 'Only the Lead or the Dean can change the group')
    if (loaded.row.status === 'completed' || loaded.row.status === 'cancelled') throw conflict('project_closed', 'This project is closed')
    return loaded
  }

  async addStudents(c: Caller, id: string, studentIds: string[], reason?: string) {
    const { facts, row } = await this.assertGroupManager(c, id)
    const why = reasonFor(c, facts, reason)
    const people = await this.tx.membership.findMany({ where: { userId: { in: studentIds }, status: 'active', roles: { some: { role: 'student' } } } })
    if (people.length !== new Set(studentIds).size) throw unprocessable('invalid_member', 'Every person must be an active student in this workspace')
    const existing = new Set(facts.members.map((m) => m.userId))
    const fresh = [...new Set(studentIds)].filter((s) => !existing.has(s))
    if (fresh.length === 0) return
    await this.tx.projectMember.createMany({
      data: fresh.map((userId) => ({ workspaceId: c.workspaceId!, projectId: id, userId, role: 'student' as const })),
    })
    const names = await this.core.people(fresh)
    await this.activity.record(c, facts, {
      category: 'people',
      action: `added ${fresh.map((s) => names.get(s)?.name ?? 'a student').join(', ')} to the group`,
      targetType: 'project',
      targetId: id,
      targetLabel: row.title,
      reason: why,
      isOverride: !!why && projectRole(c, facts) !== 'lead',
    })
    await this.notifications.notify(fresh, { kind: 'people', title: `You were added to “${row.title}”`, link: `/projects/${id}` }, { exclude: c.userId })
    await this.tx.project.update({ where: { id }, data: { version: { increment: 1 } } })
  }

  async removeStudent(c: Caller, id: string, studentId: string, reason?: string) {
    const { facts, row } = await this.assertGroupManager(c, id)
    const why = reasonFor(c, facts, reason, false)
    const m = facts.members.find((x) => x.userId === studentId && x.role === 'student')
    if (!m) throw notFound('Student')
    await this.tx.projectMember.updateMany({
      where: { projectId: id, userId: studentId, leftAt: null },
      data: { leftAt: new Date(), leftReason: why ?? 'removed', isGroupLeader: false },
    })
    const name = (await this.core.people([studentId])).get(studentId)?.name ?? 'a student'
    await this.activity.record(c, facts, {
      category: 'people',
      action: `removed ${name} from the group${m.isGroupLeader ? ' (group leader)' : ''}`,
      targetType: 'project',
      targetId: id,
      targetLabel: row.title,
      reason: why,
      isOverride: !!why && projectRole(c, facts) !== 'lead',
    })
    await this.notifications.notify([studentId], { kind: 'people', title: `You were removed from “${row.title}”`, body: why ?? '' }, { exclude: c.userId })
    // The group is never blocked: with no leader any member may submit (5.7) and the Lead is asked to pick one.
    if (m.isGroupLeader) {
      const sup = facts.members.filter((x) => x.role !== 'student').map((x) => x.userId)
      await this.notifications.notify(sup, { kind: 'people', title: `Choose a new group leader for “${row.title}”`, link: `/projects/${id}` }, { exclude: c.userId })
    }
    await this.tx.project.update({ where: { id }, data: { version: { increment: 1 } } })
  }

  async changeGroupLeader(c: Caller, id: string, studentId: string, note?: string) {
    const { facts, row } = await this.assertGroupManager(c, id)
    const why = reasonFor(c, facts, note)
    const target = facts.members.find((m) => m.userId === studentId && m.role === 'student')
    if (!target) throw unprocessable('not_in_group', 'That student is not in the group')
    const current = facts.members.find((m) => m.isGroupLeader)
    if (current?.userId === studentId) return
    // Clear first: the partial unique index allows one active leader.
    await this.tx.projectMember.updateMany({ where: { projectId: id, isGroupLeader: true, leftAt: null }, data: { isGroupLeader: false } })
    await this.tx.projectMember.updateMany({ where: { projectId: id, userId: studentId, leftAt: null }, data: { isGroupLeader: true } })
    const refs = await this.core.people([studentId, ...(current ? [current.userId] : [])])
    await this.activity.record(c, facts, {
      category: 'people',
      action: 'changed the group leader',
      targetType: 'project',
      targetId: id,
      targetLabel: row.title,
      before: current ? (refs.get(current.userId)?.name ?? '') : 'none',
      after: refs.get(studentId)?.name ?? '',
      reason: why,
      isOverride: !!why && projectRole(c, facts) !== 'lead',
    })
    await this.notifications.notify([studentId], { kind: 'people', title: `You are now group leader of “${row.title}”`, link: `/projects/${id}` }, { exclude: c.userId })
    await this.tx.project.update({ where: { id }, data: { version: { increment: 1 } } })
  }

  /** Used by workers and tests to read the label shown beside an actor. */
  roleLabel(c: Caller, f: ProjectFacts) {
    return actingRoleLabel(c, f)
  }

  authority(c: Caller, f: ProjectFacts) {
    return leaderAuthority(c, f)
  }

  approvers(f: ProjectFacts) {
    return { approvers: phaseApprovers(f), blocked: approvalBlocked(f) }
  }
}
