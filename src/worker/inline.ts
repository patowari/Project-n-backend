import { INestApplication } from '@nestjs/common'
import { JobRunner } from './runner'

/** Free-tier demo: the API process also runs the job loop. Production uses `worker.ts`. */
export async function startInlineWorker(app: INestApplication): Promise<void> {
  const runner = app.get(JobRunner)
  runner.start({ concurrency: 2 })
  app.enableShutdownHooks()
  const close = app.close.bind(app)
  app.close = async () => {
    await runner.stop()
    await close()
  }
}
