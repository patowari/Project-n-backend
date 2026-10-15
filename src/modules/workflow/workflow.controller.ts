import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { OverrideKind } from '@prisma/client'
import { Type } from 'class-transformer'
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateNested } from 'class-validator'
import { Caller } from '../../authz/caller'
import { CurrentCaller, Idempotent } from '../../common/http'
import { ParseUuid } from '../../common/pipes'
import { WorkflowService } from './workflow.service'

class SubmitDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string
}
class ReviewDto {
  @IsIn(['approved', 'changes_requested']) decision: 'approved' | 'changes_requested'
  @IsOptional() @IsString() @MaxLength(4000) comment?: string
}
class ExtensionDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) until: string
  @IsString() @Length(3, 1000) reason: string
}
class DecisionDto {
  @IsIn(['approved', 'rejected']) decision: 'approved' | 'rejected'
  @IsOptional() @IsString() @MaxLength(1000) note?: string
}
class TargetDto {
  @IsIn(['phase', 'project']) type: 'phase' | 'project'
  @IsUUID() id: string
}
class OverrideDto {
  @IsIn(['approve_phase', 'reopen_phase', 'move_deadline', 'put_on_hold', 'resume', 'complete', 'cancel']) kind: OverrideKind
  @IsOptional() @ValidateNested() @Type(() => TargetDto) target?: TargetDto
  @IsString() @MaxLength(1000) reason: string
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueDate?: string
}

@ApiTags('workflow')
@ApiBearerAuth()
@Controller()
export class WorkflowController {
  constructor(private wf: WorkflowService) {}

  /** Finalizes the draft as the next version. Retries with the same Idempotency-Key return the same version. */
  @Idempotent()
  @Post('phases/:id/submissions')
  @HttpCode(201)
  submit(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: SubmitDto, @Headers('idempotency-key') key?: string) {
    return this.wf.submit(c, id, dto, key)
  }

  @Get('projects/:id/submissions')
  async list(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    return { items: await this.wf.list(c, id), nextCursor: null }
  }

  @Post('submissions/:id/reviews')
  @HttpCode(201)
  review(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: ReviewDto) {
    return this.wf.review(c, id, dto)
  }

  @Post('submissions/:id/ai/release')
  @HttpCode(204)
  async release(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    await this.wf.releaseAi(c, id)
  }

  @Post('phases/:id/extensions')
  @HttpCode(201)
  requestExtension(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: ExtensionDto) {
    return this.wf.requestExtension(c, id, dto)
  }

  @Post('extensions/:id/decision')
  @HttpCode(204)
  async decide(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: DecisionDto) {
    await this.wf.decideExtension(c, id, dto)
  }

  @Get('projects/:id/extensions')
  async extensions(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    return { items: await this.wf.listExtensions(c, id), nextCursor: null }
  }

  /** Dean / Supervision Owner overrides. A reason is mandatory and the action is logged. */
  @Post('projects/:id/overrides')
  @HttpCode(201)
  override(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: OverrideDto) {
    return this.wf.override(c, id, dto)
  }
}
