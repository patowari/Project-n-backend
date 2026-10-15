import { Injectable } from '@nestjs/common'
import { PhaseStatus, Prisma, ProjectHealth, ProjectRole, ProjectStatus } from '@prisma/client'
import { Caller } from '../../authz/caller'
import { approvalBlocked, canViewMetadata, ProjectFacts } from '../../authz/policy'
import { notFound } from '../../common/http'
import { Db } from '../../infra/db'

export interface PersonRef {
  id: string
  name: string
  avatarUrl?: string
}
export interface NamedRef {
  id: string
  name: string
}

export interface PhaseLite {
  id: string
  projectId: string
  position: number
  name: string
  status: PhaseStatus
  dueDate: Date | null
  latestVersion: number
}

export interface LoadedProject {
  row: Prisma.ProjectGetPayload<{ include: { department: { select: { id: true; name: true; facultyId: true } } } }>
  facts: ProjectFacts
  phases: PhaseLite[]
}

export interface ProjectSummaryView {
  id: string
  title: string
  department: NamedRef | null
  status: ProjectStatus
  health: ProjectHealth
  healthReason?: string
  currentPhase: { id: string; name: string; index: number; status: PhaseStatus; dueDate: string | null } | null
  phaseCount: number
  phasesApproved: number
  lead: PersonRef | null
  coSupervisors: PersonRef[]
  students: PersonRef[]
  groupLeader: PersonRef | null
  myRole: ProjectRole | null
  flags: ('approval_blocked' | 'needs_supervisor')[]
}

export const isoDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

/**
 * Loads everything the policy functions and list views need, in a fixed
 * number of queries regardless of how many projects are involved.
 * All reads go through RLS: a project the caller may not see is simply absent.
 */
@Injectable()
export class ProjectCore {
  constructor(private db: Db) {}

  async people(ids: string[]): Promise<Map<string, PersonRef>> {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return new Map()
    const users = await this.db.tx.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, avatarUrl: true } })
    return new Map(users.map((u) => [u.id, { id: u.id, name: u.name, ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}) }]))
  }

  async load(ids: string[], opts: { phases?: boolean } = {}): Promise<Map<string, LoadedProject>> {
    const tx = this.db.tx
    const out = new Map<string, LoadedProject>()
    if (ids.length === 0) return out
    const rows = await tx.project.findMany({
      where: { id: { in: ids }, deletedAt: null },
      include: { department: { select: { id: true, name: true, facultyId: true } } },
    })
    if (rows.length === 0) return out
    const pids = rows.map((r) => r.id)

    const [members, phases] = await Promise.all([
      tx.projectMember.findMany({ where: { projectId: { in: pids }, leftAt: null }, orderBy: { joinedAt: 'asc' } }),
      opts.phases === false
        ? Promise.resolve([] as PhaseLite[])
        : tx.phase.findMany({
            where: { projectId: { in: pids } },
            orderBy: [{ projectId: 'asc' }, { position: 'asc' }],
            select: { id: true, projectId: true, position: true, name: true, status: true, dueDate: true, latestVersion: true },
          }),
    ])

    // Effective approval rights are computed inside PostgreSQL (pn_supervisor_rights).
    const rights = await tx.$queryRaw<{ project_id: string; user_id: string; can_approve: boolean }[]>`
      SELECT project_id, user_id, can_approve FROM pn_supervisor_rights(${pids}::uuid[])`

    for (const row of rows) {
      const ms = members.filter((m) => m.projectId === row.id)
      const facultyId = row.department?.facultyId ?? null
      const approvalRights = new Map<string, boolean>(rights.filter((r) => r.project_id === row.id).map((r) => [r.user_id, r.can_approve]))
      out.set(row.id, {
        row,
        phases: (phases as PhaseLite[]).filter((p) => p.projectId === row.id),
        facts: {
          id: row.id,
          workspaceId: row.workspaceId,
          status: row.status,
          departmentId: row.departmentId,
          facultyId,
          createdById: row.createdById,
          submissionMode: row.submissionMode,
          members: ms.map((m) => ({ userId: m.userId, role: m.role, isGroupLeader: m.isGroupLeader, isSuccessor: m.isSuccessor, joinedAt: m.joinedAt })),
          approvalRights,
        },
      })
    }
    return out
  }

  /** One project the caller may at least see in lists; 404 otherwise (never 403: no existence leaks). */
  async loadVisible(caller: Caller, id: string, opts: { phases?: boolean } = {}): Promise<LoadedProject> {
    const p = (await this.load([id], opts)).get(id)
    if (!p || !canViewMetadata(caller, p.facts)) throw notFound('Project')
    return p
  }

  async summaries(caller: Caller, loaded: LoadedProject[]): Promise<ProjectSummaryView[]> {
    const refs = await this.people(loaded.flatMap((l) => l.facts.members.map((m) => m.userId)))
    const ref = (id: string) => refs.get(id) ?? { id, name: 'Unknown' }
    return loaded.map(({ row, facts, phases }) => {
      const current = phases.find((p) => p.status !== 'approved') ?? null
      const lead = facts.members.find((m) => m.role === 'lead')
      const flags: ProjectSummaryView['flags'] = []
      if (!lead) flags.push('needs_supervisor')
      else if (row.status === 'active' && approvalBlocked(facts)) flags.push('approval_blocked')
      return {
        id: row.id,
        title: row.title,
        department: row.department ? { id: row.department.id, name: row.department.name } : null,
        status: row.status,
        health: row.health,
        ...(row.healthReason ? { healthReason: row.healthReason } : {}),
        currentPhase: current
          ? { id: current.id, name: current.name, index: current.position, status: current.status, dueDate: isoDate(current.dueDate) }
          : null,
        phaseCount: phases.length,
        phasesApproved: phases.filter((p) => p.status === 'approved').length,
        lead: lead ? ref(lead.userId) : null,
        coSupervisors: facts.members.filter((m) => m.role === 'co_supervisor').map((m) => ref(m.userId)),
        students: facts.members.filter((m) => m.role === 'student').map((m) => ref(m.userId)),
        groupLeader: (() => {
          const g = facts.members.find((m) => m.isGroupLeader)
          return g ? ref(g.userId) : null
        })(),
        myRole: facts.members.find((m) => m.userId === caller.userId)?.role ?? null,
        flags,
      }
    })
  }
}
