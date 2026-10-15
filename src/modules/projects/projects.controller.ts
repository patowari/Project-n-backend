import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { ProjectHealth, ProjectStatus, SubmissionMode, UnlockRule } from '@prisma/client'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator'
import type { Response } from 'express'
import { Caller } from '../../authz/caller'
import { CurrentCaller, Idempotent, Roles } from '../../common/http'
import { ParseUuid } from '../../common/pipes'
import { ProjectsService } from './projects.service'

const HEALTH: ProjectHealth[] = ['on_track', 'at_risk', 'overdue', 'awaiting_review', 'completed']
const STATUS: ProjectStatus[] = ['active', 'on_hold', 'completed', 'cancelled']
const asArray = <T extends string>(v: unknown, allowed: T[]): T[] | undefined => {
  if (v === undefined || v === '') return undefined
  const list = (Array.isArray(v) ? v : String(v).split(',')).map(String)
  return list.filter((x): x is T => (allowed as string[]).includes(x))
}

class PhaseInputDto {
  @IsString() @Length(1, 80) name: string
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueDate: string | null
}
class CreateProjectDto {
  @IsString() @Length(3, 120) title: string
  @IsOptional() @IsString() @MaxLength(1000) description?: string
  @IsOptional() @IsUUID() departmentId: string | null
  @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate: string
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => PhaseInputDto) phases: PhaseInputDto[]
  @IsIn(['on_submit', 'on_approval']) unlockRule: UnlockRule
  @IsUUID() leadId: string
  @IsArray() @ArrayMaxSize(10) @IsUUID(undefined, { each: true }) coSupervisorIds: string[]
  @IsOptional() @IsUUID() successorId: string | null
  @IsArray() @ArrayMaxSize(30) @IsUUID(undefined, { each: true }) studentIds: string[]
  @IsOptional() @IsUUID() groupLeaderId: string | null
  @IsIn(['leader_only', 'any_member']) submissionMode: SubmissionMode
  @IsBoolean() aiStudentFeedback: boolean
  @IsBoolean() aiSupervisorSummary: boolean
}
class PatchProjectDto {
  @IsOptional() @IsString() @Length(3, 120) title?: string
  @IsOptional() @IsString() @MaxLength(1000) description?: string
  @IsOptional() @IsIn(['leader_only', 'any_member']) submissionMode?: SubmissionMode
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
class AddStudentsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @IsUUID(undefined, { each: true }) studentIds: string[]
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
class RemoveStudentDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
class GroupLeaderDto {
  @IsUUID() studentId: string
  @IsOptional() @IsString() @MaxLength(500) note?: string
}

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private projects: ProjectsService) {}

  @Get()
  list(
    @CurrentCaller() c: Caller,
    @Query('scope') scope?: string,
    @Query('health') health?: unknown,
    @Query('status') status?: unknown,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ) {
    return this.projects.list(c, {
      scope: scope === 'mine' ? 'mine' : 'all',
      health: asArray(health, HEALTH),
      status: asArray(status, STATUS),
      q: q?.trim() || undefined,
      cursor,
      limit: limit ? Number(limit) : undefined,
    })
  }

  @Roles('dean', 'supervision_owner', 'supervisor')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(@CurrentCaller() c: Caller, @Body() dto: CreateProjectDto) {
    return this.projects.create(c, dto)
  }

  @Get(':id')
  async detail(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Res({ passthrough: true }) res: Response) {
    const d = await this.projects.detail(c, id)
    res.setHeader('ETag', `"v${d.version}"`)
    return d
  }

  @Patch(':id')
  async patch(
    @CurrentCaller() c: Caller,
    @Param('id', ParseUuid) id: string,
    @Body() dto: PatchProjectDto,
    @Headers('if-match') ifMatch?: string
  ) {
    return this.projects.patch(c, id, dto, ifMatch)
  }

  @Post(':id/students')
  @HttpCode(204)
  async addStudents(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: AddStudentsDto) {
    await this.projects.addStudents(c, id, dto.studentIds, dto.reason)
  }

  @Delete(':id/students/:studentId')
  @HttpCode(204)
  async removeStudent(
    @CurrentCaller() c: Caller,
    @Param('id', ParseUuid) id: string,
    @Param('studentId', ParseUuid) studentId: string,
    @Body() dto: RemoveStudentDto
  ) {
    await this.projects.removeStudent(c, id, studentId, dto?.reason)
  }

  @Put(':id/group-leader')
  @HttpCode(204)
  async groupLeader(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: GroupLeaderDto) {
    await this.projects.changeGroupLeader(c, id, dto.studentId, dto.note)
  }
}
