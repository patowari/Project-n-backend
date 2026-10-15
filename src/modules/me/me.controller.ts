import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Res } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { IsOptional, IsString, IsUUID, Length } from 'class-validator'
import { Caller } from '../../authz/caller'
import { Db } from '../../infra/db'
import { AllowUnverified, CurrentCaller, NoWorkspace } from '../../common/http'
import { MeService } from '../auth/me.view'
import { ChangeEmailDto, ChangePasswordDto } from '../auth/auth.dto'
import { MeSettingsService } from './me.service'

class DefaultWorkspaceDto {
  @IsUUID() workspaceId: string
}
class DeletionDto {
  @IsOptional() @IsString() @Length(0, 1000) reason?: string
}
@ApiTags('me')
@ApiBearerAuth()
@NoWorkspace()
@AllowUnverified()
@Controller()
export class MeController {
  constructor(
    private me: MeService,
    private settings: MeSettingsService,
    private db: Db
  ) {}

  /** The signed-in user with every membership and role (drives the whole UI). */
  @Get('me')
  get(@CurrentCaller() c: Caller) {
    return this.db.asAuth(() => this.me.build(c.userId))
  }

  @Get('me/profile')
  profile(@CurrentCaller() c: Caller) {
    return this.settings.profile(c)
  }

  @Patch('me/profile')
  @HttpCode(204)
  async updateProfile(@CurrentCaller() c: Caller, @Body() body: Record<string, unknown>) {
    await this.settings.updateProfile(c, body)
  }

  @Get('me/security')
  security(@CurrentCaller() c: Caller) {
    return this.settings.security(c)
  }

  @Post('me/password')
  @HttpCode(204)
  async password(@CurrentCaller() c: Caller, @Body() dto: ChangePasswordDto) {
    await this.settings.changePassword(c, dto.current, dto.next)
  }

  @Post('me/email')
  @HttpCode(202)
  async email(@CurrentCaller() c: Caller, @Body() dto: ChangeEmailDto) {
    await this.settings.requestEmailChange(c, dto.email)
  }

  @Delete('me/sessions/:id')
  @HttpCode(204)
  async revoke(@CurrentCaller() c: Caller, @Param('id') id: string) {
    await this.settings.revokeSession(c, id)
  }

  @Post('me/sessions/revoke-others')
  @HttpCode(204)
  async revokeOthers(@CurrentCaller() c: Caller) {
    await this.settings.revokeOthers(c)
  }

  @Get('me/notification-preferences')
  notifications(@CurrentCaller() c: Caller) {
    return this.settings.notificationPrefs(c)
  }

  @Put('me/notification-preferences')
  @HttpCode(204)
  async setNotifications(@CurrentCaller() c: Caller, @Body() body: Record<string, unknown>) {
    await this.settings.setNotificationPrefs(c, body)
  }

  @Get('me/preferences')
  preferences(@CurrentCaller() c: Caller) {
    return this.settings.preferences(c)
  }

  @Put('me/preferences')
  @HttpCode(204)
  async setPreferences(@CurrentCaller() c: Caller, @Body() body: Record<string, unknown>) {
    await this.settings.setPreferences(c, body)
  }

  @Get('me/supervision-defaults')
  supervision(@CurrentCaller() c: Caller) {
    return this.settings.supervisionDefaults(c)
  }

  @Put('me/supervision-defaults')
  @HttpCode(204)
  async setSupervision(@CurrentCaller() c: Caller, @Body() body: Record<string, unknown>) {
    await this.settings.setSupervisionDefaults(c, body)
  }

  @Get('me/invites')
  invites(@CurrentCaller() c: Caller) {
    return this.settings.myInvites(c)
  }

  @Post('invites/:id/accept')
  @HttpCode(204)
  async accept(@CurrentCaller() c: Caller, @Param('id') id: string) {
    await this.settings.respondInvite(c, id, true)
  }

  @Post('invites/:id/decline')
  @HttpCode(204)
  async decline(@CurrentCaller() c: Caller, @Param('id') id: string) {
    await this.settings.respondInvite(c, id, false)
  }

  @Get('me/default-workspace')
  async defaultWorkspace(@CurrentCaller() c: Caller, @Res() res: Response) {
    res.json(await this.settings.defaultWorkspace(c))
  }

  @Put('me/default-workspace')
  @HttpCode(204)
  async setDefaultWorkspace(@CurrentCaller() c: Caller, @Body() dto: DefaultWorkspaceDto) {
    await this.settings.setDefaultWorkspace(c, dto.workspaceId)
  }

  @Delete('workspaces/:id/membership')
  @HttpCode(204)
  async leave(@CurrentCaller() c: Caller, @Param('id') id: string) {
    await this.settings.leaveWorkspace(c, id)
  }

  @Get('me/data-requests')
  dataRequests(@CurrentCaller() c: Caller) {
    return this.settings.dataRequests(c)
  }

  @Post('me/export')
  @HttpCode(202)
  async exportData(@CurrentCaller() c: Caller) {
    await this.settings.requestExport(c)
  }

  @Post('me/deletion-request')
  @HttpCode(202)
  async requestDeletion(@CurrentCaller() c: Caller, @Body() dto: DeletionDto) {
    await this.settings.requestDeletion(c, dto.reason ?? '')
  }

  @Delete('me/deletion-request')
  @HttpCode(204)
  async cancelDeletion(@CurrentCaller() c: Caller) {
    await this.settings.cancelDeletion(c)
  }
}
