// `npm test`: real PostgreSQL 18 (embedded, no Docker) + migrations + Jest.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { startPg } from './pg-embedded.mjs'
import { bootstrapDb } from './db-bootstrap.mjs'

const port = Number(process.env.TEST_PG_PORT ?? 54329)
const exe = path.resolve('rust/doc-tools/target/release', process.platform === 'win32' ? 'pn-doc-tools.exe' : 'pn-doc-tools')
const docTools = process.env.DOC_TOOLS_BIN ?? (existsSync(exe) ? exe : 'pn-doc-tools')
const pg = await startPg({ name: 'test', port, fresh: true })
let code = 1
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await pg.stop().catch(() => {}); process.exit(130) })
try {
  const u = await bootstrapDb(pg, port)
  const args = process.argv.slice(2)
  code = await new Promise((resolve) => {
    const child = spawn('npx', ['jest', '--config', 'jest.config.js', '--runInBand', ...args], {
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: u.app,
        DATABASE_SYSTEM_URL: u.system,
        DATABASE_MIGRATION_URL: u.owner,
        DOC_TOOLS_BIN: docTools,
        RATE_LIMIT_SCALE: '100',
        ARGON_MEMORY_KIB: '4096',
        ARGON_TIME_COST: '1',
      },
    })
    child.on('exit', (c) => resolve(c ?? 1))
  })
} finally {
  await pg.stop()
}
process.exit(code)
