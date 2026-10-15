import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { JobStatus, WorkspaceStatus } from '@prisma/client'
import { IsEmail, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator'
import { Caller } from '../../authz/caller'
import { CurrentCaller, NoWorkspace, PlatformAdminOnly } from '../../common/http'
import { ParseUuid } from '../../common/pipes'
import { AdminService } from './admin.service'

class CreateInstitutionDto {
  @IsString() @Length(2, 120) name: string
  @IsString() @Length(2, 120) adminName: string
  @IsEmail() adminEmail: string
}
class StatusDto {
  @IsIn(['active', 'suspended']) status: 'active' | 'suspended'
}
class PlanDto {
  @IsString() key: string
  @IsString() @Length(2, 80) name: string
  @IsNumber() @Min(0) @Max(100000) aiMonthlyBudgetUsd: number
  @IsOptional() @Min(1) maxUsers?: number | null
}
class AssignPlanDto {
  @IsOptional() @IsUUID() planId: string | null
}

/** Platform owner only. Metadata, plans, usage and failed jobs; never project content. */
@ApiTags('admin')
@ApiBearerAuth()
@PlatformAdminOnly()
@NoWorkspace()
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService) {}

  @Get('overview')
  overview() {
    return this.admin.overview()
  }

  @Get('institutions')
  institutions(@Query('status') status?: WorkspaceStatus, @Query('type') type?: 'institution' | 'supervision', @Query('q') q?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.admin.institutions({ status, type, search: q, cursor, limit: limit ? Number(limit) : undefined })
  }

  @Post('institutions')
  @HttpCode(201)
  create(@CurrentCaller() c: Caller, @Body() dto: CreateInstitutionDto) {
    return this.admin.createInstitution(c, dto)
  }

  @Patch('institutions/:id/status')
  @HttpCode(204)
  async status(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: StatusDto) {
    await this.admin.setStatus(c, id, dto.status)
  }

  @Put('institutions/:id/plan')
  @HttpCode(204)
  async assign(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: AssignPlanDto) {
    await this.admin.assignPlan(c, id, dto.planId ?? null)
  }

  @Get('plans')
  async plans() {
    return { items: await this.admin.plans(), nextCursor: null }
  }

  @Post('plans')
  @HttpCode(201)
  createPlan(@CurrentCaller() c: Caller, @Body() dto: PlanDto) {
    return this.admin.savePlan(c, undefined, dto)
  }

  @Put('plans/:id')
  @HttpCode(204)
  async updatePlan(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: PlanDto) {
    await this.admin.savePlan(c, id, dto)
  }

  @Get('usage')
  usage() {
    return this.admin.usage()
  }

  @Get('jobs')
  jobs(@Query('status') status?: JobStatus, @Query('limit') limit?: string) {
    return this.admin.failedJobs(status, limit ? Number(limit) : undefined)
  }

  @Post('jobs/:id/retry')
  @HttpCode(204)
  async retry(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    await this.admin.retryJob(c, id)
  }
}
