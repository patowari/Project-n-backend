import 'reflect-metadata'

process.env.SERVICE_NAME ??= 'projectn-worker'
import { Logger, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { CoreModule } from './app.module'
import { JobRunner } from './worker/runner'
import { createLogger } from './common/logger'
import { loadEnv } from './config/env'
import { WORKER_PROVIDERS } from './worker/providers'

/**
 * Independently deployable worker: same code base, no HTTP server.
 * Scale it horizontally; `FOR UPDATE SKIP LOCKED` keeps instances apart.
 */
@Module({ imports: [CoreModule], providers: [...WORKER_PROVIDERS] })
class WorkerModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: createLogger(loadEnv().logLevel).app })
  app.enableShutdownHooks()
  const runner = app.get(JobRunner)
  if (process.argv.includes('--drain')) {
    const n = await runner.drain()
    new Logger('Worker').log(`drained ${n} job(s)`)
    await app.close()
    return
  }
  runner.start()
  const stop = async () => {
    await runner.stop()
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e)
  process.exit(1)
})
