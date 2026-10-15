import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator'
import { Caller } from '../../authz/caller'
import { CurrentCaller, Roles } from '../../common/http'
import { ParseUuid } from '../../common/pipes'
import { GovernanceService } from './governance.service'

class RevokeDto {
  @IsIn(['project', 'faculty']) scope: 'project' | 'faculty'
  @IsOptional() @IsUUID() projectId?: string
  @IsOptional() @IsUUID() facultyId?: string
  @IsString() @MaxLength(1000) reason: string
}
class RestoreDto {
  @IsString() @MaxLength(1000) reason: string
}
class AssignmentDto {
  @IsUUID() projectId: string
  @IsUUID() successorId: string
}
class OffboardDto {
  @IsString() @MaxLength(1000) reason: string
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => AssignmentDto) assignments?: AssignmentDto[]
}
class LeadDto {
  @IsUUID() userId: string
  @IsOptional() @IsString() @MaxLength(1000) reason?: string
}
class SuccessorDto {
  @IsOptional() @IsUUID() userId: string | null
}
class CoSupervisorDto {
  @IsUUID() userId: string
  @IsOptional() @IsString() @MaxLength(1000) reason?: string
}
class OptionalReasonDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string
}

@ApiTags('governance')
@ApiBearerAuth()
@Controller()
export class GovernanceController {
  constructor(private gov: GovernanceService) {}

  @Roles('institution_admin', 'dean', 'supervision_owner')
  @Post('people/:id/approval-revocations')
  @HttpCode(201)
  revoke(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: RevokeDto) {
    return this.gov.revoke(c, id, dto)
  }

  @Get('people/:id/approval-revocations')
  async revocations(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    return { items: await this.gov.revocations(c, id), nextCursor: null }
  }

  @Roles('institution_admin', 'dean', 'supervision_owner')
  @Post('approval-revocations/:id/restore')
  @HttpCode(204)
  async restore(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: RestoreDto) {
    await this.gov.restore(c, id, dto.reason)
  }

  @Roles('institution_admin', 'dean', 'supervision_owner')
  @Get('people/:id/offboard-preview')
  async preview(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    return { items: await this.gov.offboardPreview(c, id), nextCursor: null }
  }

  @Roles('institution_admin', 'dean', 'supervision_owner')
  @Post('people/:id/offboard')
  @HttpCode(200)
  async offboard(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: OffboardDto) {
    return { items: await this.gov.offboard(c, id, dto) }
  }

  @Put('projects/:id/lead')
  @HttpCode(204)
  async lead(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: LeadDto) {
    await this.gov.assignLead(c, id, dto)
  }

  @Put('projects/:id/successor')
  @HttpCode(204)
  async successor(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: SuccessorDto) {
    await this.gov.setSuccessor(c, id, dto.userId ?? null)
  }

  @Post('projects/:id/supervisors')
  @HttpCode(204)
  async addSupervisor(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: CoSupervisorDto) {
    await this.gov.addCoSupervisor(c, id, dto.userId, dto.reason)
  }

  @Delete('projects/:id/supervisors/:userId')
  @HttpCode(204)
  async removeSupervisor(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Param('userId', ParseUuid) userId: string, @Body() dto: OptionalReasonDto) {
    await this.gov.removeCoSupervisor(c, id, userId, dto?.reason)
  }
}
