import type { Provider, Type } from '@nestjs/common'
import { AdminController } from './admin/admin.controller'
import { AdminService } from './admin/admin.service'
import { CollabService } from './collab/collab.service'
import { InsightsController } from './insights/insights.controller'
import { InsightsService } from './insights/insights.service'
import { DriveController } from './drive/drive.controller'
import { DriveService } from './drive/drive.service'
import { OrgController } from './org/org.controller'
import { OrgService } from './org/org.service'
import { PhasesController } from './phases/phases.controller'
import { PhasesService } from './phases/phases.service'
import { ProjectCore } from './projects/project-core.service'
import { ProjectsController } from './projects/projects.controller'
import { ProjectsService } from './projects/projects.service'
import { GovernanceController } from './governance/governance.controller'
import { GovernanceService } from './governance/governance.service'
import { HealthService } from './workflow/health.service'
import { WorkflowController } from './workflow/workflow.controller'
import { WorkflowService } from './workflow/workflow.service'

/**
 * Feature controllers and providers are registered here as each workflow
 * lands, keeping app.module.ts stable.
 */
export const FEATURE_CONTROLLERS: Type<unknown>[] = [OrgController, ProjectsController, DriveController, PhasesController, WorkflowController, InsightsController, GovernanceController, AdminController]
export const FEATURE_PROVIDERS: Provider[] = [OrgService, ProjectCore, ProjectsService, DriveService, PhasesService, WorkflowService, HealthService, CollabService, InsightsService, GovernanceService, AdminService]
