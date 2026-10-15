// Starts a throw-away real PostgreSQL (no Docker needed) for tests, local
// verification and load tests. Data lives in .pgdata/<name>.
import EmbeddedPostgres from 'embedded-postgres'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * A hard-killed run leaves a postmaster behind that holds the shared-memory block.
 * Stop exactly the instance that owns THIS data directory (never anyone else's).
 */
export function stopStale(dir) {
  const pidFile = path.join(dir, 'postmaster.pid')
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0])
  if (!pid) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * PostgreSQL 18 on Windows can leave an `io_worker` child behind after a clean stop; it keeps the
 * shared-memory segment and blocks the next start. Reap postgres.exe processes whose parent is gone.
 */
export function reapOrphans() {
  if (process.platform !== 'win32') return
  const script =
    "$all = Get-CimInstance Win32_Process; $ids = $all.ProcessId; " +
    "$all | Where-Object { $_.Name -eq 'postgres.exe' -and $_.CommandLine -like '*@embedded-postgres*' -and ($ids -notcontains $_.ParentProcessId) } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' })
  } catch {
    /* nothing to reap */
  }
}

export async function startPg({ name = 'test', port = 54329, fresh = true } = {}) {
  const dir = path.resolve('.pgdata', name)
  stopStale(dir)
  reapOrphans()
  const existed = existsSync(path.join(dir, 'PG_VERSION'))
  if (fresh && existed) rmSync(dir, { recursive: true, force: true })
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: !fresh,
    // Production databases are UTF-8; so are the ones we test against.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: (e) => console.error('[pg]', e),
  })
  if (fresh || !existed) await pg.initialise()
  await pg.start()
  return pg
}
