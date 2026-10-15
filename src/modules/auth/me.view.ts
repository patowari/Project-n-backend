import { Injectable } from '@nestjs/common'
import { WorkspaceRole, WorkspaceStatus, WorkspaceType } from '@prisma/client'
import { Db } from '../../infra/db'

/** The `Me` shape the frontend stores (dashboard-ui/src/lib/roles.ts). */
export interface MeView {
  id: string
  name: string
  email: string
  avatarUrl?: string
  isPlatformAdmin: boolean
  emailVerified: boolean
  memberships: {
    workspace: { id: string; name: string; type: WorkspaceType; status: WorkspaceStatus }
    roles: { role: WorkspaceRole; scope?: { type: 'faculty' | 'department'; id: string; name: string } }[]
    canApprove: boolean
  }[]
}

@Injectable()
export class MeService {
  constructor(private db: Db) {}

  /**
   * Works with or without an active workspace. One statement (this is the most frequent call of the
   * whole UI); run it through `db.asAuth` so the auth role can see every membership of the user.
   */
  async build(userId: string): Promise<MeView> {
    type Row = {
      id: string
      name: string
      email: string
      avatar_url: string | null
      is_platform_admin: boolean
      email_verified: boolean
      memberships: {
        workspace: { id: string; name: string; type: WorkspaceType; status: WorkspaceStatus }
        can_approve: boolean
        roles: { role: WorkspaceRole; scope_type: 'faculty' | 'department' | null; scope_id: string | null; scope_name: string | null }[]
      }[]
    }
    const rows = await this.db.tx.$queryRaw<Row[]>`
      SELECT u.id, u.name, u.email, u.avatar_url, u.is_platform_admin, (u.email_verified_at IS NOT NULL) AS email_verified,
        COALESCE((
          SELECT json_agg(json_build_object(
                   'workspace', json_build_object('id', w.id, 'name', w.name, 'type', w.type, 'status', w.status),
                   'can_approve', m.can_approve,
                   'roles', COALESCE((
                     SELECT json_agg(json_build_object('role', r.role, 'scope_type', r.scope_type, 'scope_id', r.scope_id, 'scope_name', COALESCE(f.name, d.name)))
                     FROM membership_roles r
                     LEFT JOIN faculties f ON f.id = r.scope_id
                     LEFT JOIN departments d ON d.id = r.scope_id
                     WHERE r.membership_id = m.id), '[]'::json)
                 ) ORDER BY m.joined_at)
          FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_id = u.id AND m.status = 'active'), '[]'::json) AS memberships
      FROM users u WHERE u.id = ${userId}::uuid`
    const u = rows[0]
    if (!u) throw new Error('user not found')
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatar_url ?? undefined,
      isPlatformAdmin: u.is_platform_admin,
      emailVerified: u.email_verified,
      memberships: u.memberships.map((m) => ({
        workspace: m.workspace,
        canApprove: m.can_approve,
        roles: m.roles.map((r) => ({
          role: r.role,
          ...(r.scope_type && r.scope_id ? { scope: { type: r.scope_type, id: r.scope_id, name: r.scope_name ?? '' } } : {}),
        })),
      })),
    }
  }
}
