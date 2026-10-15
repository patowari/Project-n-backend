import { ProjectRole, ProjectStatus, SubmissionMode } from '@prisma/client'
import { Caller, hasRole } from './caller'

/**
 * Pure authorization rules (architecture 5.3 - 5.8). The same rules exist in
 * SQL (migration 0002: pn_content_projects, pn_supervisor_projects, ...) so a
 * query that skips this layer still cannot read what these functions deny.
 * test/policy-parity.e2e-spec.ts asserts both agree.
 */

export interface ProjectMemberFact {
  userId: string
  role: ProjectRole
  isGroupLeader: boolean
  isSuccessor: boolean
  joinedAt: Date
}

export interface ProjectFacts {
  id: string
  workspaceId: string
  status: ProjectStatus
  departmentId: string | null
  facultyId: string | null
  createdById: string
  submissionMode: SubmissionMode
  /** Active members only. */
  members: ProjectMemberFact[]
  /** userId -> has an effective approval right on this project (5.4) */
  approvalRights: Map<string, boolean>
}

export type LeaderAuthority = 'owner' | 'dean' | 'head' | null

export function projectRole(c: Caller, p: ProjectFacts): ProjectRole | null {
  return p.members.find((m) => m.userId === c.userId)?.role ?? null
}

export function isGroupLeader(c: Caller, p: ProjectFacts): boolean {
  return p.members.some((m) => m.userId === c.userId && m.isGroupLeader)
}

/** The widest monitoring authority the caller has over this project. */
export function leaderAuthority(c: Caller, p: ProjectFacts): LeaderAuthority {
  if (hasRole(c, 'supervision_owner')) return 'owner'
  const dean = c.grants.some((g) => g.role === 'dean' && g.scopeId && g.scopeId === p.facultyId)
  if (dean) return 'dean'
  const head = c.grants.some((g) => g.role === 'head' && g.scopeId && g.scopeId === p.departmentId)
  if (head) return 'head'
  return null
}

export const isSupervisorOn = (c: Caller, p: ProjectFacts) => {
  const r = projectRole(c, p)
  return r === 'lead' || r === 'co_supervisor'
}

/** Open submissions, comments, files. Not the Institution Admin, not the Super Admin. */
export const canViewContent = (c: Caller, p: ProjectFacts) =>
  projectRole(c, p) !== null || leaderAuthority(c, p) !== null

/** Title, health and counts only. */
export const canViewMetadata = (c: Caller, p: ProjectFacts) =>
  canViewContent(c, p) || hasRole(c, 'institution_admin') || p.createdById === c.userId

/** Supervisors-only comments and AI summaries. */
export const seesSupervisorOnly = (c: Caller, p: ProjectFacts) =>
  isSupervisorOn(c, p) || leaderAuthority(c, p) !== null

export const canComment = (c: Caller, p: ProjectFacts) => canViewContent(c, p)

/** Dean override authority: Dean of the faculty or the Supervision Owner (5.5). */
export const canOverride = (c: Caller, p: ProjectFacts) => {
  const a = leaderAuthority(c, p)
  return a === 'dean' || a === 'owner'
}

/** Lead or Dean/Owner: timeline, group, people (5.7, 10.1). */
export const canManageProject = (c: Caller, p: ProjectFacts) =>
  projectRole(c, p) === 'lead' || canOverride(c, p)

/** Review = approve or request changes on a version (not sign off). */
export const canReview = (c: Caller, p: ProjectFacts) => isSupervisorOn(c, p)

/**
 * 5.4: the Lead signs off if they hold the approval right; otherwise any
 * co-supervisor with the right; otherwise nobody (approval blocked).
 */
export function phaseApprovers(p: ProjectFacts): string[] {
  const lead = p.members.find((m) => m.role === 'lead')
  if (lead && p.approvalRights.get(lead.userId)) return [lead.userId]
  return p.members.filter((m) => m.role === 'co_supervisor' && p.approvalRights.get(m.userId)).map((m) => m.userId)
}

export const approvalBlocked = (p: ProjectFacts) => phaseApprovers(p).length === 0

/** Routine approval (no override). */
export const canApprove = (c: Caller, p: ProjectFacts) => phaseApprovers(p).includes(c.userId)

/** Group submission rules (5.7). */
export function canSubmit(c: Caller, p: ProjectFacts): boolean {
  if (projectRole(c, p) !== 'student') return false
  const students = p.members.filter((m) => m.role === 'student')
  const leader = students.find((m) => m.isGroupLeader)
  if (students.length <= 1) return true
  // A group with no leader is never blocked: any member may submit.
  if (!leader) return true
  return p.submissionMode === 'any_member' || leader.userId === c.userId
}

export const canUpload = (c: Caller, p: ProjectFacts) => projectRole(c, p) === 'student'

export function canRequestExtension(c: Caller, p: ProjectFacts): boolean {
  if (projectRole(c, p) !== 'student') return false
  const students = p.members.filter((m) => m.role === 'student')
  return students.length <= 1 || isGroupLeader(c, p) || !students.some((m) => m.isGroupLeader)
}

export const canLogTime = (c: Caller, p: ProjectFacts) => projectRole(c, p) !== null

/** Label shown with comments and log entries (overview: "Clear labels"). */
export function actingRoleLabel(c: Caller, p: ProjectFacts): string {
  const r = projectRole(c, p)
  if (r === 'lead' || r === 'co_supervisor') return 'Supervisor'
  if (r === 'student') return isGroupLeader(c, p) ? 'Group leader' : 'Student'
  switch (leaderAuthority(c, p)) {
    case 'dean':
      return 'Dean'
    case 'head':
      return 'Head'
    case 'owner':
      return 'Owner'
    default:
      return hasRole(c, 'institution_admin') ? 'Institution Admin' : 'Member'
  }
}
