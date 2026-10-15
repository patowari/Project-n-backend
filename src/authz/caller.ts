import { WorkspaceRole, WorkspaceType, WorkspaceStatus } from '@prisma/client'

/** Role names used in guards. `super_admin` is the platform flag, not a membership. */
export type Role = WorkspaceRole | 'super_admin'

export interface RoleGrant {
  role: WorkspaceRole
  scopeType: 'faculty' | 'department' | null
  scopeId: string | null
}

/** Built once per request, inside the request's tenant transaction. */
export interface Caller {
  userId: string
  name: string
  email: string
  emailVerified: boolean
  isPlatformAdmin: boolean
  sessionId: string
  workspaceId: string | null
  workspaceType: WorkspaceType | null
  workspaceStatus: WorkspaceStatus | null
  membershipId: string | null
  /** Institution Admin granted approval permission (architecture 5.4). */
  canApprove: boolean
  grants: RoleGrant[]
}

export const rolesOf = (c: Caller): Set<Role> => {
  const s = new Set<Role>(c.grants.map((g) => g.role))
  if (c.isPlatformAdmin) s.add('super_admin')
  return s
}

export const hasRole = (c: Caller, ...roles: Role[]) => {
  const have = rolesOf(c)
  return roles.some((r) => have.has(r))
}

export const isLeader = (c: Caller) => hasRole(c, 'dean', 'head', 'supervision_owner')
