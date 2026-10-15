import 'reflect-metadata'
import { writeFileSync } from 'node:fs'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { configureApp } from './configure-app'
import { loadEnv } from './config/env'
import { buildOpenApi } from './openapi'

/**
 * Writes openapi.json. Must run from the COMPILED output (`nest build`), because
 * the Swagger compiler plugin that documents the request DTOs only runs there.
 * No database connection is made.
 */
async function main() {
  process.env.DATABASE_URL ??= 'postgresql://x:x@localhost:1/x'
  const env = loadEnv()
  const app = await NestFactory.create(AppModule, { logger: false })
  configureApp(app, env)
  await app.init()
  writeFileSync(process.argv[2] ?? 'openapi.json', JSON.stringify(buildOpenApi(app), null, 2))
  await app.close()
}
main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e)
  process.exit(1)
})
