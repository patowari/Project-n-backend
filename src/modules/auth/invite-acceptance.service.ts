import { HttpStatus, Injectable } from '@nestjs/common'
import { Invite } from '@prisma/client'
import { ApiError, forbidden, notFound } from '../../common/http'
import { sha256 } from '../../common/crypto'
import { Db } from '../../infra/db'
import { AuditService } from '../core/core.services'
import { AuthResult, AuthService } from './auth.service'
import { assertAcceptablePassword, PasswordService } from './password'

@Injectable()
export class InviteAcceptanceService {
  constructor(
    private db: Db,
    private pw: PasswordService,
    private auth: AuthService,
    private audit: AuditService
  ) {}

  /** What the invitation page shows before the person signs up. */
  async preview(token: string) {
    return this.db.asAuth(async () => {
      const inv = await this.db.tx.invite.findUnique({ where: { tokenHash: sha256(token) } })
      if (!inv || inv.status !== 'pending' || inv.expiresAt < new Date()) {
        throw new ApiError(HttpStatus.GONE, 'invite_invalid', 'This invitation is no longer valid')
      }
      const [workspace, inviter, user] = await Promise.all([
        this.db.tx.workspace.findUnique({ where: { id: inv.workspaceId }, select: { name: true } }),
        this.db.tx.user.findUnique({ where: { id: inv.invitedById }, select: { name: true } }),
        this.db.tx.user.findUnique({ where: { email: inv.email }, select: { id: true } }),
      ])
      return {
        email: inv.email,
        name: inv.name,
        role: inv.role,
        workspaceName: workspace?.name ?? '',
        invitedBy: inviter?.name ?? '',
        expiresAt: inv.expiresAt,
        accountExists: !!user,
      }
    })
  }

  /** New person: creates the account (e-mail counts as verified), joins, signs in. */
  async acceptByToken(token: string, input: { name?: string; password?: string }): Promise<AuthResult> {
    const peek = await this.db.asAuth(async () => {
      const inv = await this.db.tx.invite.findUnique({ where: { tokenHash: sha256(token) } })
      if (!inv || inv.status !== 'pending' || inv.expiresAt < new Date()) return null
      const user = await this.db.tx.user.findUnique({ where: { email: inv.email }, select: { id: true } })
      return { inv, exists: !!user }
    })
    if (!peek) throw new ApiError(HttpStatus.GONE, 'invite_invalid', 'This invitation is no longer valid')
    if (peek.exists) {
      throw new ApiError(HttpStatus.CONFLICT, 'account_exists', 'You already have an account. Sign in to accept this invitation')
    }
    const name = (input.name ?? peek.inv.name).trim()
    if (name.length < 2) throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'name_required', 'Please enter your name')
    if (!input.password) throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'password_required', 'Choose a password')
    assertAcceptablePassword(input.password, { email: peek.inv.email, name })
    const passwordHash = await this.pw.hash(input.password)

    const userId = await this.db.asAuth(async () => {
      const tx = this.db.tx
      const claimed = await tx.invite.updateMany({
        where: { id: peek.inv.id, status: 'pending' },
        data: { status: 'accepted', acceptedAt: new Date() },
      })
      if (claimed.count === 0) throw new ApiError(HttpStatus.GONE, 'invite_invalid', 'This invitation is no longer valid')
      const user = await tx.user.create({
        data: { email: peek.inv.email, name, passwordHash, passwordChangedAt: new Date(), emailVerifiedAt: new Date(), defaultWorkspaceId: peek.inv.workspaceId },
      })
      await this.db.setUser(user.id)
      await this.applyInvite(peek.inv, user.id)
      await this.audit.log('invite.accepted', { actorId: user.id, workspaceId: peek.inv.workspaceId, targetType: 'invite', targetId: peek.inv.id })
      return user.id
    })
    return this.auth.startSession(userId)
  }

  /** Signed-in person accepts an invitation addressed to their e-mail. */
  async acceptById(userId: string, inviteId: string): Promise<void> {
    await this.db.asAuth(async () => {
      const inv = await this.db.tx.invite.findFirst({ where: { id: inviteId, status: 'pending' } })
      if (!inv || inv.expiresAt < new Date()) throw notFound('Invitation')
      const me = await this.db.tx.user.findUniqueOrThrow({ where: { id: userId } })
      if (inv.email !== me.email) throw forbidden('not_your_invite', 'This invitation was sent to a different e-mail address')
      await this.db.tx.invite.update({ where: { id: inv.id }, data: { status: 'accepted', acceptedAt: new Date() } })
      await this.applyInvite(inv, userId)
      await this.audit.log('invite.accepted', { actorId: userId, workspaceId: inv.workspaceId, targetType: 'invite', targetId: inv.id })
    })
  }

  async decideById(userId: string, inviteId: string, accept: boolean): Promise<void> {
    if (accept) return this.acceptById(userId, inviteId)
    await this.db.asAuth(async () => {
      const inv = await this.db.tx.invite.findFirst({ where: { id: inviteId, status: 'pending' } })
      if (!inv) throw notFound('Invitation')
      const me = await this.db.tx.user.findUniqueOrThrow({ where: { id: userId } })
      if (inv.email !== me.email) throw forbidden('not_your_invite', 'This invitation was sent to a different e-mail address')
      await this.db.tx.invite.update({ where: { id: inv.id }, data: { status: 'declined' } })
    })
  }

  /** Creates or extends the membership. Runs against the invite's workspace. */
  private applyInvite(inv: Invite, userId: string): Promise<void> {
    return this.db.inWorkspace(inv.workspaceId, async () => {
      const tx = this.db.tx
      const settings = await tx.workspaceSettings.findUnique({ where: { workspaceId: inv.workspaceId } })
      const defaultApprove = inv.role === 'supervisor' ? (settings?.newSupervisorsCanApprove ?? false) : false
      let m = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId } } })
      if (!m) {
        m = await tx.membership.create({
          data: {
            workspaceId: inv.workspaceId,
            userId,
            departmentId: inv.departmentId,
            studentCode: inv.studentCode,
            canApprove: inv.canApprove ?? defaultApprove,
          },
        })
      } else if (m.status !== 'active') {
        m = await tx.membership.update({ where: { id: m.id }, data: { status: 'active' } })
      }
      const has = await tx.membershipRole.findFirst({
        where: { membershipId: m.id, role: inv.role, scopeId: inv.scopeId },
      })
      if (!has) {
        await tx.membershipRole.create({
          data: { workspaceId: inv.workspaceId, membershipId: m.id, role: inv.role, scopeType: inv.scopeType, scopeId: inv.scopeId },
        })
      }
    })
  }
}
