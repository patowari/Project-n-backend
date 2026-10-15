import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator'
import { Caller } from '../../authz/caller'
import { CurrentCaller, forbidden, notFound, Roles } from '../../common/http'
import { ParseUuid } from '../../common/pipes'
import { OrgService } from './org.service'

const MANAGERS = ['institution_admin', 'dean', 'supervision_owner'] as const

class SaveFacultyDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string
  @IsOptional() @IsUUID() deanId?: string | null
}
class SaveDepartmentDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string
  @IsOptional() @IsUUID() facultyId?: string
  @IsOptional() @IsUUID() headId?: string | null
}
class InviteDto {
  @IsIn(['supervisor', 'student']) role: 'supervisor' | 'student'
  @IsString() @Length(2, 120) name: string
  @IsString() @Length(3, 254) email: string
  @IsOptional() @IsUUID() departmentId?: string | null
  @IsOptional() @IsString() @Length(0, 60) studentId?: string
}
class ImportDto {
  @IsArray() @ArrayMaxSize(5000) rows: Record<string, unknown>[]
}
class UpdateMemberDto {
  @IsOptional() @IsUUID() departmentId?: string
  @IsOptional() @IsBoolean() canApprove?: boolean
  @IsOptional() @IsIn(['active', 'deactivated']) status?: 'active' | 'deactivated'
}
class PhaseItemDto {
  @IsString() @Length(1, 80) name: string
  @IsInt() @Min(1) @Max(730) durationDays: number
}
class TemplateDto {
  @IsString() @Length(2, 80) name: string
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => PhaseItemDto) phases: PhaseItemDto[]
}

@ApiTags('organization')
@ApiBearerAuth()
@Controller()
export class OrgController {
  constructor(private org: OrgService) {}

  /* faculties */

  @Roles('institution_admin', 'dean')
  @Get('org/faculties')
  async faculties(@CurrentCaller() c: Caller) {
    return { items: await this.org.faculties(c), nextCursor: null }
  }

  @Roles('institution_admin')
  @Post('org/faculties')
  @HttpCode(201)
  createFaculty(@CurrentCaller() c: Caller, @Body() dto: SaveFacultyDto) {
    return this.org.saveFaculty(c, undefined, dto)
  }

  @Roles('institution_admin')
  @Patch('org/faculties/:id')
  @HttpCode(204)
  async updateFaculty(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: SaveFacultyDto) {
    await this.org.saveFaculty(c, id, dto)
  }

  @Roles('institution_admin')
  @Delete('org/faculties/:id')
  @HttpCode(204)
  async deleteFaculty(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    await this.org.deleteFaculty(c, id)
  }

  /* departments */

  @Roles('institution_admin', 'dean', 'head', 'supervisor')
  @Get('org/departments')
  async departments(@CurrentCaller() c: Caller, @Query('expand') expand?: string) {
    if (expand === 'counts') {
      if (!c.grants.some((g) => ['institution_admin', 'dean', 'head'].includes(g.role))) throw forbidden()
      return { items: await this.org.departments(c), nextCursor: null }
    }
    return { items: await this.org.departmentNames(c), nextCursor: null }
  }

  @Roles('institution_admin', 'dean')
  @Post('org/departments')
  @HttpCode(201)
  createDepartment(@CurrentCaller() c: Caller, @Body() dto: SaveDepartmentDto) {
    return this.org.saveDepartment(c, undefined, dto)
  }

  @Roles('institution_admin', 'dean')
  @Patch('org/departments/:id')
  @HttpCode(204)
  async updateDepartment(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: SaveDepartmentDto) {
    await this.org.saveDepartment(c, id, dto)
  }

  @Roles('institution_admin')
  @Delete('org/departments/:id')
  @HttpCode(204)
  async deleteDepartment(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    await this.org.deleteDepartment(c, id)
  }

  /* people */

  @Roles('institution_admin', 'dean', 'head', 'supervisor', 'supervision_owner')
  @Get('people')
  async people(
    @CurrentCaller() c: Caller,
    @Query('role') role: string,
    @Query('expand') expand?: string,
    @Query('q') q?: string
  ) {
    if (role !== 'supervisor' && role !== 'student') throw notFound('Role')
    const counts = expand === 'counts'
    if (counts && !c.grants.some((g) => (MANAGERS as readonly string[]).includes(g.role))) throw forbidden()
    return { items: await this.org.people(c, { role, counts, search: q }), nextCursor: null }
  }

  @Roles('institution_admin', 'dean', 'supervision_owner')
  @Patch('people/:id')
  @HttpCode(204)
  async updateMember(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: UpdateMemberDto) {
    await this.org.updateMember(c, id, dto)
  }

  @Roles('institution_admin', 'dean', 'supervision_owner')
  @Post('people/:id/resend-invite')
  @HttpCode(204)
  async resend(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    await this.org.resendInvite(c, id)
  }

  /* invites */

  @Roles('institution_admin', 'dean', 'supervision_owner')
  @Post('workspaces/:id/invites')
  @HttpCode(201)
  async invite(@CurrentCaller() c: Caller, @Param('id') id: string, @Body() dto: InviteDto) {
    this.sameWorkspace(c, id)
    await this.org.invite(c, dto)
  }

  @Roles('institution_admin', 'dean', 'supervision_owner')
  @Post('workspaces/:id/invites/import')
  @HttpCode(200)
  async importInvites(@CurrentCaller() c: Caller, @Param('id') id: string, @Body() dto: ImportDto) {
    this.sameWorkspace(c, id)
    return this.org.inviteMany(c, dto.rows as unknown as Parameters<OrgService['inviteMany']>[1])
  }

  /* workspace settings */

  @Roles('institution_admin', 'supervision_owner')
  @Get('workspaces/:id/settings')
  settings(@CurrentCaller() c: Caller, @Param('id') id: string) {
    this.sameWorkspace(c, id)
    return this.org.workspaceSettings(c)
  }

  @Roles('institution_admin', 'supervision_owner')
  @Patch('workspaces/:id/settings')
  @HttpCode(204)
  async updateSettings(@CurrentCaller() c: Caller, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    this.sameWorkspace(c, id)
    await this.org.updateWorkspaceSettings(c, body)
  }

  /* phase templates */

  @Get('phase-templates')
  async templates() {
    return { items: await this.org.phaseTemplates(), nextCursor: null }
  }

  @Roles('institution_admin', 'supervision_owner')
  @Post('phase-templates')
  @HttpCode(201)
  createTemplate(@CurrentCaller() c: Caller, @Body() dto: TemplateDto) {
    return this.org.savePhaseTemplate(c, undefined, dto)
  }

  @Roles('institution_admin', 'supervision_owner')
  @Put('phase-templates/:id')
  @HttpCode(204)
  async updateTemplate(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: TemplateDto) {
    await this.org.savePhaseTemplate(c, id, dto)
  }

  @Roles('institution_admin', 'supervision_owner')
  @Delete('phase-templates/:id')
  @HttpCode(204)
  async deleteTemplate(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    await this.org.deletePhaseTemplate(c, id)
  }

  private sameWorkspace(c: Caller, id: string) {
    // A workspace id in the path must be the one in the header, otherwise
    // the RLS context would not match the resource the caller named.
    if (id !== c.workspaceId) throw notFound('Workspace')
  }
}
