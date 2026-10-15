import { Global, Module } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { AuthGuard, RateLimitGuard } from './common/guards'
import { ProblemFilter } from './common/problem.filter'
import { TenantInterceptor } from './common/tenant.interceptor'
import { SnakeCaseInterceptor } from './common/wire'
import { ENV, Env, loadEnv } from './config/env'
import { Db } from './infra/db'
import { KvService } from './infra/kv'
import { PrismaService, SystemPrismaService } from './infra/prisma.service'
import { AuthController } from './modules/auth/auth.controller'
import { AuthService } from './modules/auth/auth.service'
import { InviteAcceptanceService } from './modules/auth/invite-acceptance.service'
import { MeService } from './modules/auth/me.view'
import { PasswordService } from './modules/auth/password'
import { TokenService } from './modules/auth/token.service'
import { ActivityService, AuditService, JobsService, NotificationService } from './modules/core/core.services'
import { HealthController } from './modules/health/health.controller'
import { DrivePort } from './integrations/drive.port'
import { FakeDriveGateway } from './integrations/drive.fake'
import { GoogleDriveGateway } from './integrations/drive.google'
import { MeController } from './modules/me/me.controller'
import { MeSettingsService } from './modules/me/me.service'
import { WORKER_PROVIDERS } from './worker/providers'
import { FEATURE_CONTROLLERS, FEATURE_PROVIDERS } from './modules/features'

/** Infrastructure shared by every feature. */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: loadEnv },
    PrismaService,
    SystemPrismaService,
    Db,
    KvService,
    TokenService,
    PasswordService,
    JobsService,
    AuditService,
    ActivityService,
    NotificationService,
    FakeDriveGateway,
    GoogleDriveGateway,
    {
      provide: DrivePort,
      inject: [ENV, FakeDriveGateway, GoogleDriveGateway],
      useFactory: (env: Env, fake: FakeDriveGateway, google: GoogleDriveGateway): DrivePort => (env.driveDriver === 'google' ? google : fake),
    },
  ],
  exports: [
    ENV,
    PrismaService,
    SystemPrismaService,
    Db,
    KvService,
    TokenService,
    PasswordService,
    JobsService,
    AuditService,
    ActivityService,
    NotificationService,
    DrivePort,
    FakeDriveGateway,
  ],
})
export class CoreModule {}

@Module({
  imports: [CoreModule],
  controllers: [HealthController, AuthController, MeController, ...FEATURE_CONTROLLERS],
  providers: [
    AuthService,
    MeService,
    InviteAcceptanceService,
    MeSettingsService,
    ...FEATURE_PROVIDERS,
    ...WORKER_PROVIDERS,
    // Order matters: guards run first (token, rate limit); of the interceptors
    // the first listed wraps the others, so the response is converted to
    // snake_case AFTER the request transaction has committed.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: SnakeCaseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule {}
