import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { CommentTargetType } from '@prisma/client'
import { Type } from 'class-transformer'
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator'
import type { Response } from 'express'
import { Caller } from '../../authz/caller'
import { CurrentCaller, forbidden, RateLimit, Roles } from '../../common/http'
import { ParseUuid } from '../../common/pipes'
import { CollabService } from '../collab/collab.service'
import { InsightsService } from './insights.service'

class CommentTargetDto {
  @IsIn(['project', 'phase', 'submission']) type: CommentTargetType
  @IsUUID() id: string
  @IsOptional() @IsString() @MaxLength(120) label?: string
}
class CommentDto {
  @IsUUID() projectId: string
  @IsString() @Length(1, 5000) body: string
  @IsOptional() @IsBoolean() supervisorsOnly?: boolean
  @ValidateNested() @Type(() => CommentTargetDto) target: CommentTargetDto
  @IsOptional() @IsUUID() parentId?: string
}
class TimeLogDto {
  @IsUUID() projectId: string
  @IsIn(['hours', 'meeting']) kind: 'hours' | 'meeting'
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.25) @Max(24) hours: number
  @IsOptional() @IsString() @MaxLength(500) note?: string
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string
}
class ReadDto {
  @IsOptional() @IsUUID(undefined, { each: true }) ids?: string[]
  @IsOptional() @IsBoolean() all?: boolean
}

@ApiTags('insights')
@ApiBearerAuth()
@Controller()
export class InsightsController {
  constructor(
    private insights: InsightsService,
    private collab: CollabService
  ) {}

  /* comments and time */

  @Get('comments')
  async comments(@CurrentCaller() c: Caller, @Query('project_id', ParseUuid) projectId: string) {
    return { items: await this.collab.comments(c, projectId), nextCursor: null }
  }

  @RateLimit({ by: 'user', limit: 30, windowSec: 60 })
  @Post('comments')
  @HttpCode(201)
  postComment(@CurrentCaller() c: Caller, @Body() dto: CommentDto) {
    return this.collab.postComment(c, dto)
  }

  @Get('time-logs')
  async timeLogs(@CurrentCaller() c: Caller, @Query('project_id', ParseUuid) projectId: string) {
    return { items: await this.collab.timeLogs(c, projectId), nextCursor: null }
  }

  @Post('time-logs')
  @HttpCode(201)
  logTime(@CurrentCaller() c: Caller, @Body() dto: TimeLogDto) {
    return this.collab.logTime(c, dto)
  }

  /* notifications */

  @Get('notifications')
  notifications(@CurrentCaller() c: Caller, @Query('unread') unread?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.insights.notifications(c, { unread: unread === 'true', cursor, limit: limit ? Number(limit) : undefined })
  }

  @Get('notifications/unread-count')
  unread(@CurrentCaller() c: Caller) {
    return this.insights.unreadCount(c)
  }

  @Post('notifications/read')
  @HttpCode(204)
  async read(@CurrentCaller() c: Caller, @Body() dto: ReadDto) {
    await this.insights.markRead(c, dto.all ? 'all' : (dto.ids ?? []))
  }

  /* activity */

  @Get('activity')
  activity(
    @Query('from') from?: string, @Query('to') to?: string, @Query('project') project?: string, @Query('person') person?: string,
    @Query('type') type?: string, @Query('department') department?: string, @Query('overrides_only') overridesOnly?: string,
    @Query('cursor') cursor?: string, @Query('limit') limit?: string
  ) {
    return this.insights.activity({ from, to, project, person, type, department, overridesOnly: overridesOnly === 'true', cursor, limit: limit ? Number(limit) : undefined })
  }

  @Get('projects/:id/activity')
  async projectActivity(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Query('cursor') cursor?: string) {
    const page = await this.insights.activity({ cursor }, id)
    return page
  }

  @Roles('dean', 'head', 'supervision_owner')
  @Get('activity/export.csv')
  async exportCsv(
    @CurrentCaller() c: Caller, @Res() res: Response,
    @Query('from') from?: string, @Query('to') to?: string, @Query('project') project?: string, @Query('person') person?: string,
    @Query('type') type?: string, @Query('department') department?: string, @Query('overrides_only') overridesOnly?: string
  ) {
    const csv = await this.insights.activityCsv(c, { from, to, project, person, type, department, overridesOnly: overridesOnly === 'true' })
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`)
    res.send(csv)
  }

  /* calendar, queue, reports */

  @Get('calendar')
  calendar(@Query('from') from: string, @Query('to') to: string) {
    return this.insights.calendar(from, to)
  }

  @Get('reviews/queue')
  queue(@CurrentCaller() c: Caller) {
    return this.insights.reviewQueue(c)
  }

  @Get('submissions')
  mine(@CurrentCaller() c: Caller, @Query('mine') mine?: string) {
    if (mine !== 'true') throw forbidden('unsupported', 'Use /projects/{id}/submissions or ?mine=true')
    return this.insights.mySubmissions(c)
  }

  @Roles('dean', 'head', 'supervision_owner')
  @Get('reports/summary')
  report(@CurrentCaller() c: Caller) {
    return this.insights.reportSummary(c)
  }

  @Roles('dean', 'head', 'supervision_owner')
  @Get('supervisors/overview')
  overview(@CurrentCaller() c: Caller) {
    return this.insights.supervisorOverview(c)
  }
}
