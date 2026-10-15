import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'
import { configureApp } from './configure-app'
import { loadEnv } from './config/env'
import { PrismaService } from './infra/prisma.service'
import { createLogger } from './common/logger'
import { setupOpenApi } from './openapi'

async function bootstrap() {
  const env = loadEnv()
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: createLogger(env.logLevel).app })
  configureApp(app, env)
  setupOpenApi(app, env)
  await app.get(PrismaService).assertRlsEnforced()
  if (env.inlineWorker) {
    // Free-tier demo only: run the job loop inside the API process.
    const { startInlineWorker } = await import('./worker/inline')
    await startInlineWorker(app)
  }
  await app.listen(env.port, '0.0.0.0')
  new Logger('Bootstrap').log(`API listening on :${env.port} (${env.nodeEnv}, cache=${env.redisUrl ? 'redis' : 'memory'})`)
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e)
  process.exit(1)
})
