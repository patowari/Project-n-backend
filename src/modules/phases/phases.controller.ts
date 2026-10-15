import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express'
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator'
import { memoryStorage } from 'multer'
import { Caller } from '../../authz/caller'
import { CurrentCaller, unprocessable } from '../../common/http'
import { ParseUuid } from '../../common/pipes'
import { PhasesService, UploadedFile as UF } from './phases.service'

const HARD_CAP = 200 * 1024 * 1024 // workspace limit (default 50 MB) is enforced in the service
const upload = { storage: memoryStorage(), limits: { fileSize: HARD_CAP, files: 10 } }

class RequirementDto {
  @IsOptional() @IsString() id?: string
  @IsString() @Length(1, 120) name: string
  @IsBoolean() optional: boolean
}
class PatchPhaseDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string
  @IsOptional() @IsString() @MaxLength(4000) description?: string
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueDate?: string | null
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => RequirementDto) requirements?: RequirementDto[]
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
class AddPhaseDto {
  @IsString() @Length(1, 80) name: string
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueDate: string | null
}
class PhaseReasonDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string
}
class ResourceDto {
  @IsOptional() @IsString() kind?: string
  @IsOptional() @IsString() @MaxLength(120) name?: string
  @IsOptional() @IsString() @MaxLength(2000) url?: string
}
class DraftUploadDto {
  @IsOptional() @IsUUID() requirementId?: string
}
class UploadSessionDto {
  @IsString() @Length(1, 200) name: string
  @IsInt() @Min(1) @Max(5 * 1024 * 1024 * 1024) sizeBytes: number
  @IsString() @Length(1, 120) mimeType: string
}
class ConfirmUploadDto {
  @IsString() @Length(1, 200) driveFileId: string
  @IsOptional() @IsUUID() requirementId?: string
}

const toUpload = (f: Express.Multer.File): UF => ({ originalname: f.originalname, mimetype: f.mimetype || 'application/octet-stream', size: f.size, buffer: f.buffer })

@ApiTags('phases')
@ApiBearerAuth()
@Controller()
export class PhasesController {
  constructor(private phases: PhasesService) {}

  @Post('projects/:id/phases')
  @HttpCode(201)
  async add(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: AddPhaseDto) {
    return { id: await this.phases.addPhase(c, id, { name: dto.name, dueDate: dto.dueDate ?? null }) }
  }

  @Patch('phases/:id')
  @HttpCode(204)
  async patch(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: PatchPhaseDto) {
    await this.phases.updatePhase(c, id, dto as Parameters<PhasesService['updatePhase']>[2])
  }

  @Delete('phases/:id')
  @HttpCode(204)
  async remove(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    await this.phases.deletePhase(c, id)
  }

  @Post('phases/:id/unlock')
  @HttpCode(204)
  async unlock(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: PhaseReasonDto) {
    await this.phases.setOpen(c, id, true, dto?.reason)
  }

  @Post('phases/:id/lock')
  @HttpCode(204)
  async lock(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: PhaseReasonDto) {
    await this.phases.setOpen(c, id, false, dto?.reason)
  }

  /* resources: a link (JSON) or a guide file (multipart) */

  @Post('phases/:id/resources')
  @ApiConsumes('application/json', 'multipart/form-data')
  @UseInterceptors(FileInterceptor('file', upload))
  @HttpCode(201)
  async addResource(
    @CurrentCaller() c: Caller,
    @Param('id', ParseUuid) id: string,
    @Body() dto: ResourceDto,
    @UploadedFile() file?: Express.Multer.File
  ) {
    if (file) await this.phases.addResource(c, id, { kind: 'file', file: toUpload(file) })
    else {
      if (dto.kind !== 'link' || !dto.url) throw unprocessable('invalid_resource', 'Send a file, or a link with a name and url')
      await this.phases.addResource(c, id, { kind: 'link', name: dto.name ?? '', url: dto.url })
    }
  }

  @Delete('phases/:id/resources/:resourceId')
  @HttpCode(204)
  async removeResource(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Param('resourceId', ParseUuid) rid: string) {
    await this.phases.removeResource(c, id, rid)
  }

  /* drafts: files gathered for the next version */

  @Get('phases/:id/draft')
  draft(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string) {
    return this.phases.draft(c, id)
  }

  @Post('phases/:id/draft/files')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('files', 10, upload))
  @HttpCode(201)
  async uploadFiles(
    @CurrentCaller() c: Caller,
    @Param('id', ParseUuid) id: string,
    @Body() dto: DraftUploadDto,
    @UploadedFiles() files: Express.Multer.File[] = []
  ) {
    await this.phases.uploadDraft(c, id, files.map(toUpload), dto?.requirementId)
  }

  /** Large files: ask for a resumable Google Drive URL and upload straight to Google. */
  @Post('phases/:id/draft/uploads')
  @HttpCode(201)
  session(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: UploadSessionDto, @Headers('origin') origin?: string) {
    return this.phases.uploadSession(c, id, dto, origin ?? '')
  }

  @Post('phases/:id/draft/uploads/confirm')
  @HttpCode(201)
  async confirm(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Body() dto: ConfirmUploadDto) {
    await this.phases.confirmUpload(c, id, dto)
  }

  @Delete('phases/:id/draft/files/:fileId')
  @HttpCode(204)
  async removeFile(@CurrentCaller() c: Caller, @Param('id', ParseUuid) id: string, @Param('fileId', ParseUuid) fileId: string) {
    await this.phases.removeDraftFile(c, id, fileId)
  }
}
