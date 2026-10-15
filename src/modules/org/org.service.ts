import { Inject, Injectable } from '@nestjs/common'
import { Prisma, WorkspaceRole } from '@prisma/client'
import { Caller, hasRole } from '../../authz/caller'
import { conflict, forbidden, notFound, unprocessable } from '../../common/http'
import { randomToken, sha256 } from '../../common/crypto'
import { ENV, Env } from '../../config/env'
import { Db } from '../../infra/db'
import { ActivityService, AuditService, JobsService, NotificationService } from '../core/core.services'
import { NamedRef, PersonRef } from '../projects/project-core.service'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface InviteInput {
  role: 'supervisor' | 'student'
  name: string
  email: string
  departmentId?: string | null
  studentId?: string
}

/** What a caller may see of the institution's people (architecture 5.3). */
export interface PeopleScope {
  all: boolean
  facultyIds: string[]
  departmentIds: string[]
}

@Injectable()
export class OrgService {
  constructor(
    private db: Db,
    private jobs: JobsService,
    private audit: AuditService,
    private activity: ActivityService,
    private notifications: NotificationService,
    @Inject(ENV) private env: Env
  ) {}

  private get tx() {
    return this.db.tx
  }

  /* ------------------------------ scope ------------------------------ */

  /** Workspace-wide for Admin / Owner; a faculty for a Dean; a department for a Head. */
  async scope(c: Caller): Promise<PeopleScope> {
    if (hasRole(c, 'institution_admin', 'supervision_owner')) return { all: true, facultyIds: [], departmentIds: [] }
    const facultyIds = c.grants.filter((g) => g.role === 'dean' && g.scopeId).map((g) => g.scopeId!)
    const departmentIds = c.grants.filter((g) => g.role === 'head' && g.scopeId).map((g) => g.scopeId!)
    if (hasRole(c, 'supervisor') && c.membershipId) {
      const m = await this.tx.membership.findUnique({ where: { id: c.membershipId }, select: { department: { select: { id: true, facultyId: true } } } })
      if (m?.department) facultyIds.push(m.department.facultyId)
    }
    return { all: false, facultyIds: [...new Set(facultyIds)], departmentIds: [...new Set(departmentIds)] }
  }

  async departmentIdsIn(scope: PeopleScope): Promise<string[] | null> {
    if (scope.all) return null
    const rows = await this.tx.department.findMany({
      where: { OR: [{ facultyId: { in: scope.facultyIds } }, { id: { in: scope.departmentIds } }] },
      select: { id: true },
    })
    return rows.map((r) => r.id)
  }

  async assertDepartmentInScope(c: Caller, departmentId: string) {
    const ids = await this.departmentIdsIn(await this.scope(c))
    if (ids && !ids.includes(departmentId)) throw forbidden('out_of_scope', 'That department is outside your area')
  }

  /* --------------------------- faculties --------------------------- */

  async faculties(c: Caller) {
    const scope = await this.scope(c)
    const faculties = await this.tx.faculty.findMany({
      where: scope.all ? {} : { id: { in: scope.facultyIds } },
      orderBy: { name: 'asc' },
    })
    if (faculties.length === 0) return []
    const ids = faculties.map((f) => f.id)
    const [deans, depts, supervisors, students, projects] = await Promise.all([
      this.tx.membershipRole.findMany({ where: { role: 'dean', scopeId: { in: ids } }, include: { membership: { select: { userId: true } } } }),
      this.tx.department.groupBy({ by: ['facultyId'], where: { facultyId: { in: ids } }, _count: true }),
      this.countPeopleByFaculty('supervisor', ids),
      this.countPeopleByFaculty('student', ids),
      this.tx.$queryRaw<{ faculty_id: string; n: bigint }[]>`
        SELECT d.faculty_id, count(*) n FROM projects p JOIN departments d ON d.id = p.department_id
        WHERE p.status = 'active' AND p.deleted_at IS NULL AND d.faculty_id = ANY(${ids}::uuid[]) GROUP BY d.faculty_id`,
    ])
    const refs = await this.userRefs(deans.map((d) => d.membership.userId))
    return faculties.map((f) => {
      const dean = deans.find((d) => d.scopeId === f.id)
      return {
        id: f.id,
        name: f.name,
        dean: dean ? (refs.get(dean.membership.userId) ?? null) : null,
        departments: depts.find((d) => d.facultyId === f.id)?._count ?? 0,
        supervisors: supervisors.get(f.id) ?? 0,
        students: students.get(f.id) ?? 0,
        activeProjects: Number(projects.find((p) => p.faculty_id === f.id)?.n ?? 0),
      }
    })
  }

  private async countPeopleByFaculty(role: WorkspaceRole, facultyIds: string[]): Promise<Map<string, number>> {
    const rows = await this.tx.$queryRaw<{ faculty_id: string; n: bigint }[]>`
      SELECT d.faculty_id, count(DISTINCT m.id) n
      FROM memberships m
      JOIN departments d ON d.id = m.department_id
      JOIN membership_roles r ON r.membership_id = m.id AND r.role = ${role}::workspace_role
      WHERE m.status = 'active' AND d.faculty_id = ANY(${facultyIds}::uuid[]) GROUP BY d.faculty_id`
    return new Map(rows.map((r) => [r.faculty_id, Number(r.n)]))
  }

  async userRefs(ids: string[]): Promise<Map<string, PersonRef>> {
    if (ids.length === 0) return new Map()
    const users = await this.tx.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, avatarUrl: true } })
    return new Map(users.map((u) => [u.id, { id: u.id, name: u.name, ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}) }]))
  }

  private async assertActiveMember(userId: string) {
    const m = await this.tx.membership.findFirst({ where: { userId, status: 'active' }, select: { id: true } })
    if (!m) throw unprocessable('not_a_member', 'That person is not an active member of this workspace')
    return m
  }

  /** Dean of a faculty / Head of a department: one at a time (replaced, not stacked). */
  private async setHolder(role: 'dean' | 'head', scopeId: string, userId: string | null) {
    const c = this.db.ctx
    await this.tx.membershipRole.deleteMany({ where: { role, scopeId } })
    if (!userId) return
    const m = await this.assertActiveMember(userId)
    await this.tx.membershipRole.create({
      data: { workspaceId: c.workspaceId!, membershipId: m.id, role, scopeType: role === 'dean' ? 'faculty' : 'department', scopeId },
    })
  }

  async saveFaculty(c: Caller, id: string | undefined, v: { name?: string; deanId?: string | null }) {
    if (!hasRole(c, 'institution_admin')) throw forbidden()
    const name = v.name?.trim()
    if (!id && !name) throw unprocessable('name_required', 'Give the faculty a name')
    let fid = id
    if (id) {
      if (name) await this.tx.faculty.update({ where: { id }, data: { name } })
      else await this.tx.faculty.findUniqueOrThrow({ where: { id } })
    } else {
      const f = await this.tx.faculty.create({ data: { workspaceId: c.workspaceId!, name: name! } })
      fid = f.id
    }
    if (v.deanId !== undefined) await this.setHolder('dean', fid!, v.deanId)
    await this.activity.record(c, null, { category: 'people', action: id ? 'updated faculty' : 'created faculty', targetType: 'faculty', targetId: fid, targetLabel: name ?? '' })
    await this.audit.log('org.faculty_saved', { actorId: c.userId, targetType: 'faculty', targetId: fid })
    return { id: fid }
  }

  async deleteFaculty(c: Caller, id: string) {
    if (!hasRole(c, 'institution_admin')) throw forbidden()
    const n = await this.tx.department.count({ where: { facultyId: id } })
    if (n > 0) throw conflict('faculty_not_empty', 'Remove or move its departments first')
    await this.tx.membershipRole.deleteMany({ where: { role: 'dean', scopeId: id } })
    await this.tx.faculty.delete({ where: { id } })
    await this.audit.log('org.faculty_deleted', { actorId: c.userId, targetType: 'faculty', targetId: id })
  }

  /* --------------------------- departments --------------------------- */

  /** Names only, in the caller's area (project forms). */
  async departmentNames(c: Caller): Promise<NamedRef[]> {
    const ids = await this.departmentIdsIn(await this.scope(c))
    const rows = await this.tx.department.findMany({ where: ids ? { id: { in: ids } } : {}, orderBy: { name: 'asc' }, select: { id: true, name: true } })
    return rows
  }

  async departments(c: Caller) {
    const ids = await this.departmentIdsIn(await this.scope(c))
    const departments = await this.tx.department.findMany({
      where: ids ? { id: { in: ids } } : {},
      include: { faculty: { select: { id: true, name: true } } },
      orderBy: [{ faculty: { name: 'asc' } }, { name: 'asc' }],
    })
    if (departments.length === 0) return []
    const dids = departments.map((d) => d.id)
    const [heads, counts, projects] = await Promise.all([
      this.tx.membershipRole.findMany({ where: { role: 'head', scopeId: { in: dids } }, include: { membership: { select: { userId: true } } } }),
      this.tx.$queryRaw<{ department_id: string; role: string; n: bigint }[]>`
        SELECT m.department_id, r.role::text AS role, count(DISTINCT m.id) n
        FROM memberships m JOIN membership_roles r ON r.membership_id = m.id AND r.role IN ('supervisor','student')
        WHERE m.status = 'active' AND m.department_id = ANY(${dids}::uuid[]) GROUP BY m.department_id, r.role`,
      this.tx.project.groupBy({ by: ['departmentId'], where: { departmentId: { in: dids }, status: 'active', deletedAt: null }, _count: true }),
    ])
    const refs = await this.userRefs(heads.map((h) => h.membership.userId))
    return departments.map((d) => {
      const head = heads.find((h) => h.scopeId === d.id)
      const n = (role: string) => Number(counts.find((x) => x.department_id === d.id && x.role === role)?.n ?? 0)
      return {
        id: d.id,
        name: d.name,
        faculty: d.faculty,
        head: head ? (refs.get(head.membership.userId) ?? null) : null,
        supervisors: n('supervisor'),
        students: n('student'),
        activeProjects: projects.find((p) => p.departmentId === d.id)?._count ?? 0,
      }
    })
  }

  async saveDepartment(c: Caller, id: string | undefined, v: { name?: string; facultyId?: string; headId?: string | null }) {
    // Admin sets up the structure; a Dean may manage departments inside their faculty (5.8).
    const facultyId = v.facultyId
    if (!hasRole(c, 'institution_admin')) {
      const dean = c.grants.filter((g) => g.role === 'dean').map((g) => g.scopeId)
      if (!hasRole(c, 'dean') || !facultyId || !dean.includes(facultyId)) throw forbidden()
    }
    const name = v.name?.trim()
    if (!id && (!name || !facultyId)) throw unprocessable('invalid_department', 'Name and faculty are required')
    let did = id
    if (id) {
      await this.tx.department.update({ where: { id }, data: { ...(name ? { name } : {}), ...(facultyId ? { facultyId } : {}) } })
    } else {
      const d = await this.tx.department.create({ data: { workspaceId: c.workspaceId!, name: name!, facultyId: facultyId! } })
      did = d.id
    }
    if (v.headId !== undefined) await this.setHolder('head', did!, v.headId)
    await this.activity.record(c, null, { category: 'people', action: id ? 'updated department' : 'created department', targetType: 'department', targetId: did, targetLabel: name ?? '' })
    return { id: did }
  }

  async deleteDepartment(c: Caller, id: string) {
    if (!hasRole(c, 'institution_admin')) throw forbidden()
    const [people, projects] = await Promise.all([
      this.tx.membership.count({ where: { departmentId: id, status: 'active' } }),
      this.tx.project.count({ where: { departmentId: id, deletedAt: null } }),
    ])
    if (people + projects > 0) throw conflict('department_not_empty', 'Move its people and projects first')
    await this.tx.membershipRole.deleteMany({ where: { role: 'head', scopeId: id } })
    await this.tx.department.delete({ where: { id } })
    await this.audit.log('org.department_deleted', { actorId: c.userId, targetType: 'department', targetId: id })
  }

  /* ----------------------------- people ----------------------------- */

  /**
   * Picker (names + e-mail) and, with `counts`, the Teachers / Students pages.
   * Invited-but-not-yet-joined people only appear on the pages (they have no
   * account to assign to a project).
   */
  async people(c: Caller, q: { role: 'supervisor' | 'student'; counts: boolean; search?: string }) {
    const scope = await this.scope(c)
    const dids = await this.departmentIdsIn(scope)
    const memberWhere: Prisma.MembershipWhereInput = {
      roles: { some: { role: q.role } },
      status: q.counts ? { in: ['active', 'deactivated'] } : 'active',
      ...(dids ? { departmentId: { in: dids } } : {}),
    }
    const memberships = await this.tx.membership.findMany({
      where: memberWhere,
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } }, department: { select: { id: true, name: true, facultyId: true } }, roles: true },
      orderBy: { user: { name: 'asc' } },
      take: 500,
    })
    const search = q.search?.toLowerCase()
    const filtered = search ? memberships.filter((m) => m.user.name.toLowerCase().includes(search) || m.user.email.includes(search)) : memberships

    const invites = q.counts
      ? await this.tx.invite.findMany({
          where: { role: q.role, status: 'pending', expiresAt: { gt: new Date() }, ...(dids ? { departmentId: { in: dids } } : {}) },
          orderBy: { createdAt: 'desc' },
          take: 500,
        })
      : []
    const deptNames = new Map<string, { id: string; name: string; facultyId: string }>()
    if (invites.length) {
      const ds = await this.tx.department.findMany({ where: { id: { in: invites.map((i) => i.departmentId).filter((x): x is string => !!x) } }, select: { id: true, name: true, facultyId: true } })
      ds.forEach((d) => deptNames.set(d.id, d))
    }

    let activeCounts = new Map<string, number>()
    let facultyNames = new Map<string, string>()
    let titles = new Map<string, string[]>()
    if (q.counts && filtered.length) {
      const uids = filtered.map((m) => m.userId)
      const rows = await this.tx.projectMember.groupBy({
        by: ['userId'],
        where: { userId: { in: uids }, leftAt: null, project: { status: 'active', deletedAt: null }, ...(q.role === 'supervisor' ? { role: { in: ['lead', 'co_supervisor'] } } : { role: 'student' }) },
        _count: true,
      })
      activeCounts = new Map(rows.map((r) => [r.userId, r._count]))
      const facs = await this.tx.faculty.findMany({ select: { id: true, name: true } })
      facultyNames = new Map(facs.map((f) => [f.id, f.name]))
      const leaderRoles = filtered.flatMap((m) => m.roles.filter((r) => r.scopeId).map((r) => ({ uid: m.userId, r })))
      const depts = await this.tx.department.findMany({ select: { id: true, name: true } })
      const dn = new Map(depts.map((d) => [d.id, d.name]))
      titles = new Map()
      for (const { uid, r } of leaderRoles) {
        const label = r.role === 'dean' ? `Dean of ${facultyNames.get(r.scopeId!) ?? ''}` : `Head of ${dn.get(r.scopeId!) ?? ''}`
        titles.set(uid, [...(titles.get(uid) ?? []), label])
      }
    }

    const items = filtered.map((m) => {
      const base = {
        id: m.userId,
        name: m.user.name,
        email: m.user.email,
        ...(m.user.avatarUrl ? { avatarUrl: m.user.avatarUrl } : {}),
        ...(m.department ? { department: { id: m.department.id, name: m.department.name } } : {}),
        status: m.status === 'deactivated' ? ('deactivated' as const) : ('active' as const),
        ...(q.role === 'supervisor' ? { canApprove: m.canApprove } : { studentId: m.studentCode ?? undefined }),
      }
      return q.counts
        ? {
            ...base,
            ...(m.department ? { faculty: { id: m.department.facultyId, name: facultyNames.get(m.department.facultyId) ?? '' } } : {}),
            activeProjects: activeCounts.get(m.userId) ?? 0,
            titles: titles.get(m.userId) ?? [],
          }
        : base
    })
    const pending = invites.map((i) => {
      const d = i.departmentId ? deptNames.get(i.departmentId) : undefined
      return {
        id: i.id,
        name: i.name || i.email,
        email: i.email,
        ...(d ? { department: { id: d.id, name: d.name }, faculty: { id: d.facultyId, name: facultyNames.get(d.facultyId) ?? '' } } : {}),
        status: 'invited' as const,
        ...(q.role === 'supervisor' ? { canApprove: i.canApprove ?? false } : { studentId: i.studentCode ?? undefined }),
        activeProjects: 0,
        titles: [] as string[],
      }
    })
    return [...items, ...pending]
  }

  /* ----------------------------- invites ----------------------------- */

  private canInvite(c: Caller) {
    return hasRole(c, 'institution_admin', 'supervision_owner', 'dean')
  }

  private async prepareInvite(c: Caller, v: InviteInput, existingEmails: Set<string>, pendingEmails: Set<string>) {
    const email = (v.email ?? '').trim().toLowerCase()
    const name = (v.name ?? '').trim()
    if (!EMAIL_RE.test(email) || email.length > 254) throw new Error(`"${v.email}" is not a valid e-mail address.`)
    if (name.length < 2) throw new Error('Name is required.')
    if (v.role !== 'supervisor' && v.role !== 'student') throw new Error('Role must be supervisor or student.')
    if (existingEmails.has(email)) throw new Error(`${email} is already in this workspace.`)
    if (pendingEmails.has(`${email}:${v.role}`)) throw new Error(`${email} already has a pending invitation.`)
    const institution = c.workspaceType === 'institution'
    if (institution && !v.departmentId) throw new Error('Choose a department.')
    return { email, name }
  }

  async invite(c: Caller, v: InviteInput) {
    if (!this.canInvite(c)) throw forbidden()
    const r = await this.inviteMany(c, [v])
    if (r.errors.length) throw unprocessable('invalid_invite', r.errors[0].message)
  }

  /** Bulk path used by CSV import: set-based lookups, one insert, queued e-mails. */
  async inviteMany(c: Caller, rows: InviteInput[]): Promise<{ created: number; errors: { row: number; message: string }[] }> {
    if (!this.canInvite(c)) throw forbidden()
    if (rows.length > 5000) throw unprocessable('too_many_rows', 'Import at most 5,000 rows at a time')
    const errors: { row: number; message: string }[] = []
    const emails = rows.map((r) => (r.email ?? '').trim().toLowerCase()).filter(Boolean)

    const [members, pending, workspace, settings] = await Promise.all([
      this.tx.membership.findMany({ where: { user: { email: { in: emails } }, status: { not: 'deactivated' } }, select: { user: { select: { email: true } } } }),
      this.tx.invite.findMany({ where: { email: { in: emails }, status: 'pending' }, select: { email: true, role: true } }),
      this.tx.workspace.findUniqueOrThrow({ where: { id: c.workspaceId! }, select: { name: true } }),
      this.tx.workspaceSettings.findUnique({ where: { workspaceId: c.workspaceId! } }),
    ])
    const existing = new Set(members.map((m) => m.user.email))
    const pend = new Set(pending.map((p) => `${p.email}:${p.role}`))
    const allowedDepts = new Set((await this.departmentIdsIn(await this.scope(c))) ?? [])
    const scoped = !hasRole(c, 'institution_admin', 'supervision_owner')
    const validDepts = new Set((await this.tx.department.findMany({ select: { id: true } })).map((d) => d.id))

    const batchSeen = new Set<string>()
    const toCreate: Prisma.InviteCreateManyInput[] = []
    const mails: { to: string; data: Record<string, unknown> }[] = []
    const inviter = c.name

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      try {
        const { email, name } = await this.prepareInvite(c, r, existing, pend)
        if (batchSeen.has(`${email}:${r.role}`)) throw new Error(`${email} appears twice in this file.`)
        batchSeen.add(`${email}:${r.role}`)
        if (r.departmentId) {
          if (!validDepts.has(r.departmentId)) throw new Error('Unknown department.')
          if (scoped && !allowedDepts.has(r.departmentId)) throw new Error('That department is outside your area.')
        }
        const token = randomToken()
        toCreate.push({
          workspaceId: c.workspaceId!,
          email,
          name,
          role: r.role,
          departmentId: r.departmentId || null,
          studentCode: r.role === 'student' ? r.studentId?.trim() || null : null,
          canApprove: r.role === 'supervisor' ? (settings?.newSupervisorsCanApprove ?? false) : null,
          tokenHash: sha256(token),
          invitedById: c.userId,
          expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
        })
        mails.push({ to: email, data: { name, workspaceName: workspace.name, invitedBy: inviter, role: r.role, link: `${this.env.appBaseUrl}/invite/${token}` } })
      } catch (e) {
        errors.push({ row: i + 2, message: e instanceof Error ? e.message : 'Invalid row' })
      }
    }
    if (toCreate.length) {
      await this.tx.invite.createMany({ data: toCreate })
      for (const m of mails) await this.jobs.email(m.to, 'invite', m.data)
      await this.activity.record(c, null, {
        category: 'people',
        action: toCreate.length === 1 ? `invited ${toCreate[0].email}` : `invited ${toCreate.length} people`,
        targetType: 'invite',
        targetLabel: toCreate.length === 1 ? toCreate[0].role : 'bulk import',
      })
      await this.audit.log('org.invited', { actorId: c.userId, data: { count: toCreate.length } })
    }
    return { created: toCreate.length, errors }
  }

  async resendInvite(c: Caller, id: string) {
    if (!this.canInvite(c)) throw forbidden()
    const inv = await this.tx.invite.findFirst({ where: { id, status: 'pending' } })
    if (!inv) throw notFound('Invitation')
    const token = randomToken()
    // The old link stops working; the app role may not UPDATE jobs but may update invites.
    await this.tx.invite.update({ where: { id }, data: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000) } })
    const ws = await this.tx.workspace.findUniqueOrThrow({ where: { id: inv.workspaceId }, select: { name: true } })
    await this.jobs.email(inv.email, 'invite', { name: inv.name, workspaceName: ws.name, invitedBy: c.name, role: inv.role, link: `${this.env.appBaseUrl}/invite/${token}` })
  }

  /* --------------------- member updates (PATCH /people/:id) --------------------- */

  async updateMember(c: Caller, id: string, v: { departmentId?: string; canApprove?: boolean; status?: 'active' | 'deactivated' }) {
    // An id is either a user id (joined) or an invite id (pending).
    const membership = await this.tx.membership.findFirst({
      where: { userId: id },
      include: { user: { select: { name: true } }, roles: true, department: { select: { facultyId: true } } },
    })
    if (!membership) return this.updatePendingInvite(c, id, v)

    const scope = await this.scope(c)
    const dids = await this.departmentIdsIn(scope)
    const inScope = scope.all || (!!membership.departmentId && !!dids?.includes(membership.departmentId))
    const privileged = hasRole(c, 'institution_admin', 'supervision_owner') || (hasRole(c, 'dean') && inScope)
    if (!privileged) throw forbidden()

    const data: Prisma.MembershipUpdateInput = {}
    if (v.departmentId) {
      if (!hasRole(c, 'institution_admin') && !(await this.departmentIdsIn(scope))?.includes(v.departmentId)) throw forbidden('out_of_scope', 'That department is outside your area')
      data.department = { connect: { workspaceId_id: { workspaceId: c.workspaceId!, id: v.departmentId } } }
    }
    if (v.canApprove !== undefined && v.canApprove !== membership.canApprove) {
      data.canApprove = v.canApprove
    }
    if (v.status && v.status !== membership.status) {
      if (v.status === 'deactivated') {
        const leads = await this.tx.projectMember.count({ where: { userId: id, role: 'lead', leftAt: null, project: { status: { in: ['active', 'on_hold'] } } } })
        if (leads > 0) throw conflict('has_projects_to_hand_over', 'This person leads projects. Use Offboard so each project gets a new Lead')
        await this.removeFromProjects(id, 'deactivated')
      }
      data.status = v.status
    }
    if (Object.keys(data).length === 0) return
    await this.tx.membership.update({ where: { id: membership.id }, data })

    if (data.canApprove !== undefined) {
      await this.activity.record(c, null, {
        category: 'governance',
        action: `${v.canApprove ? 'granted' : 'removed'} approval permission for ${membership.user.name}`,
        targetType: 'user',
        targetId: id,
        before: String(membership.canApprove),
        after: String(v.canApprove),
        visibility: 'supervisors',
      })
      await this.jobs.enqueue('governance.reassign_queue', { userId: id, workspaceId: c.workspaceId })
      await this.notifications.notify([id], {
        kind: 'people',
        title: v.canApprove ? 'You can now approve phases' : 'Your approval permission was removed',
        body: 'You can still review and comment.',
        link: '/reviews',
      })
    }
    if (data.status) {
      await this.activity.record(c, null, { category: 'people', action: `${v.status === 'active' ? 'reactivated' : 'deactivated'} ${membership.user.name}`, targetType: 'user', targetId: id })
    }
    await this.audit.log('org.member_updated', { actorId: c.userId, targetType: 'user', targetId: id, data: { ...v } })
  }

  private async updatePendingInvite(c: Caller, inviteId: string, v: { departmentId?: string; canApprove?: boolean; status?: string }) {
    if (!this.canInvite(c)) throw forbidden()
    const inv = await this.tx.invite.findFirst({ where: { id: inviteId, status: 'pending' } })
    if (!inv) throw notFound('Person')
    await this.tx.invite.update({
      where: { id: inviteId },
      data: {
        ...(v.departmentId ? { departmentId: v.departmentId } : {}),
        ...(v.canApprove !== undefined ? { canApprove: v.canApprove } : {}),
        ...(v.status === 'deactivated' ? { status: 'revoked' as const } : {}),
      },
    })
  }

  /** Students and co-supervisors leave their projects; the group never ends up leaderless without a rule. */
  async removeFromProjects(userId: string, reason: string) {
    const rows = await this.tx.projectMember.findMany({ where: { userId, leftAt: null } })
    for (const m of rows) {
      await this.tx.projectMember.update({ where: { id: m.id }, data: { leftAt: new Date(), leftReason: reason, isGroupLeader: false, isSuccessor: false } })
    }
  }

  /* ------------------------------ settings ------------------------------ */

  async workspaceSettings(c: Caller) {
    const [ws, s, spent] = await Promise.all([
      this.tx.workspace.findUniqueOrThrow({ where: { id: c.workspaceId! } }),
      this.tx.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: c.workspaceId! } }),
      this.tx.$queryRaw<{ total: Prisma.Decimal | null }[]>`
        SELECT COALESCE(sum(cost_usd), 0) AS total FROM ai_usage WHERE created_at >= date_trunc('month', now())`,
    ])
    const term = (s.term ?? {}) as { name?: string; start?: string; end?: string }
    return {
      name: ws.name,
      shortName: ws.shortName,
      logoUrl: ws.logoUrl,
      newSupervisorsCanApprove: s.newSupervisorsCanApprove,
      supervisorsCanCreateProjects: s.supervisorsCanCreateProjects,
      aiEnabled: s.aiEnabled,
      aiMonthlyBudgetUsd: Number(s.aiMonthlyBudgetUsd),
      aiSpentUsd: Number(spent[0]?.total ?? 0),
      allowedFileTypes: s.allowedFileTypes,
      maxFileMb: s.maxFileMb,
      atRiskAfterDays: s.atRiskAfterDays,
      escalateOverdueAfterDays: s.escalateOverdueAfterDays,
      currentTerm: { name: term.name ?? '', start: term.start ?? '', end: term.end ?? '' },
    }
  }

  async updateWorkspaceSettings(c: Caller, v: Record<string, unknown>) {
    const ws: Prisma.WorkspaceUpdateInput = {}
    const s: Prisma.WorkspaceSettingsUpdateInput = {}
    const str = (k: string, max: number) => (typeof v[k] === 'string' ? (v[k] as string).trim().slice(0, max) : undefined)
    const bool = (k: string) => (typeof v[k] === 'boolean' ? (v[k] as boolean) : undefined)
    const int = (k: string, lo: number, hi: number) => {
      if (v[k] === undefined) return undefined
      const n = Number(v[k])
      if (!Number.isInteger(n) || n < lo || n > hi) throw unprocessable('invalid_setting', `${k} must be between ${lo} and ${hi}`)
      return n
    }
    const name = str('name', 120)
    if (name !== undefined) {
      if (name.length < 2) throw unprocessable('invalid_setting', 'name is too short')
      ws.name = name
    }
    if (str('shortName', 24) !== undefined) ws.shortName = str('shortName', 24)
    if (v.logoUrl === null || typeof v.logoUrl === 'string') {
      if (v.logoUrl && !/^https:\/\//.test(v.logoUrl as string)) throw unprocessable('invalid_setting', 'logoUrl must be https')
      ws.logoUrl = v.logoUrl as string | null
    }
    Object.assign(s, {
      newSupervisorsCanApprove: bool('newSupervisorsCanApprove'),
      supervisorsCanCreateProjects: bool('supervisorsCanCreateProjects'),
      aiEnabled: bool('aiEnabled'),
      maxFileMb: int('maxFileMb', 1, 200),
      atRiskAfterDays: int('atRiskAfterDays', 1, 90),
      escalateOverdueAfterDays: int('escalateOverdueAfterDays', 0, 90),
    })
    if (v.aiMonthlyBudgetUsd !== undefined) {
      const b = Number(v.aiMonthlyBudgetUsd)
      if (!(b >= 0 && b <= 100000)) throw unprocessable('invalid_setting', 'aiMonthlyBudgetUsd is out of range')
      s.aiMonthlyBudgetUsd = b
    }
    if (Array.isArray(v.allowedFileTypes)) {
      const types = (v.allowedFileTypes as unknown[]).map((t) => String(t).toLowerCase().replace(/^\./, '')).filter((t) => /^[a-z0-9]{1,8}$/.test(t))
      if (types.length === 0) throw unprocessable('invalid_setting', 'Allow at least one file type')
      s.allowedFileTypes = { set: [...new Set(types)] }
    }
    if (v.currentTerm && typeof v.currentTerm === 'object') {
      const t = v.currentTerm as Record<string, unknown>
      s.term = { name: String(t.name ?? '').slice(0, 60), start: String(t.start ?? '').slice(0, 10), end: String(t.end ?? '').slice(0, 10) }
    }
    Object.keys(s).forEach((k) => (s as Record<string, unknown>)[k] === undefined && delete (s as Record<string, unknown>)[k])
    if (Object.keys(ws).length) await this.tx.workspace.update({ where: { id: c.workspaceId! }, data: ws })
    if (Object.keys(s).length) await this.tx.workspaceSettings.update({ where: { workspaceId: c.workspaceId! }, data: s })
    await this.audit.log('workspace.settings_updated', { actorId: c.userId, targetType: 'workspace', targetId: c.workspaceId!, data: { keys: Object.keys({ ...ws, ...s }) } })
  }

  /* ------------------------- phase templates ------------------------- */

  async phaseTemplates() {
    const rows = await this.tx.phaseTemplate.findMany({ include: { items: { orderBy: { position: 'asc' } } }, orderBy: { name: 'asc' } })
    return rows.map((t) => ({ id: t.id, name: t.name, phases: t.items.map((i) => ({ name: i.name, durationDays: i.durationDays })) }))
  }

  async savePhaseTemplate(c: Caller, id: string | undefined, v: { name: string; phases: { name: string; durationDays: number }[] }) {
    if (!hasRole(c, 'institution_admin', 'supervision_owner')) throw forbidden()
    const phases = v.phases.map((p, i) => ({ position: i + 1, name: p.name.trim(), durationDays: p.durationDays }))
    if (phases.length === 0 || phases.some((p) => !p.name || p.durationDays < 1 || p.durationDays > 730)) {
      throw unprocessable('invalid_template', 'Each phase needs a name and 1 to 730 days')
    }
    const wid = c.workspaceId!
    let tid = id
    if (id) {
      await this.tx.phaseTemplate.update({ where: { id }, data: { name: v.name.trim() } })
      await this.tx.phaseTemplateItem.deleteMany({ where: { templateId: id } })
    } else {
      tid = (await this.tx.phaseTemplate.create({ data: { workspaceId: wid, name: v.name.trim() } })).id
    }
    await this.tx.phaseTemplateItem.createMany({ data: phases.map((p) => ({ ...p, workspaceId: wid, templateId: tid! })) })
    return { id: tid }
  }

  async deletePhaseTemplate(c: Caller, id: string) {
    if (!hasRole(c, 'institution_admin', 'supervision_owner')) throw forbidden()
    await this.tx.phaseTemplate.delete({ where: { id } })
  }
}
