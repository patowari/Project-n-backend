import { Body, Controller, Delete, Get, HttpCode, Patch, Post, Query, Res } from '@nestjs/common'
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger'
import { IsString, Length } from 'class-validator'
import type { Response } from 'express'
import { Caller } from '../../authz/caller'
import { CurrentCaller, NoWorkspace, Public } from '../../common/http'
import { Db } from '../../infra/db'
import { DriveService } from './drive.service'

class FolderDto {
  @IsString() @Length(1, 80) rootFolder: string
}

@ApiTags('integrations')
@Controller('integrations/google-drive')
export class DriveController {
  constructor(
    private drive: DriveService,
    private db: Db
  ) {}

  @ApiBearerAuth()
  @NoWorkspace()
  @Get()
  async view(@CurrentCaller() c: Caller) {
    return this.drive.view(c.userId)
  }

  @ApiBearerAuth()
  @NoWorkspace()
  @Post('connect')
  @HttpCode(200)
  connect(@CurrentCaller() c: Caller) {
    return this.drive.startConnect(c.userId)
  }

  /** Google redirects the browser here. Identity comes from the one-time `state`. */
  @ApiExcludeEndpoint()
  @Public()
  @Get('callback')
  async callback(@Query('state') state: string, @Query('code') code: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    const to = await this.drive.finishConnect(state ?? '', code, error)
    res.redirect(302, to)
  }

  @ApiBearerAuth()
  @NoWorkspace()
  @Delete()
  @HttpCode(204)
  async disconnect(@CurrentCaller() c: Caller) {
    await this.drive.disconnect(c.userId)
  }

  @ApiBearerAuth()
  @NoWorkspace()
  @Patch()
  @HttpCode(204)
  async rename(@CurrentCaller() c: Caller, @Body() dto: FolderDto) {
    await this.drive.setRootFolder(c.userId, dto.rootFolder.trim())
  }
}
