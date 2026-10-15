const { PrismaClient } = require('@prisma/client')
const { Client } = require('pg')
;(async () => {
  const url = 'postgresql://projectn_app:app_pw@localhost:54360/projectn?connection_limit=5'
  const prisma = new PrismaClient({ datasources: { db: { url } } })
  const bench = async (label, n, fn) => {
    const c0 = process.cpuUsage(); const t0 = performance.now()
    for (let i = 0; i < n; i++) await fn(i)
    const c = process.cpuUsage(c0); const ms = performance.now() - t0
    console.log(label.padEnd(44), 'wall', (ms / n).toFixed(3), 'ms/op   cpu', ((c.user + c.system) / 1000 / n).toFixed(3), 'ms/op')
  }
  await prisma.$queryRaw`SELECT 1`
  await bench('prisma $queryRaw SELECT 1', 2000, () => prisma.$queryRaw`SELECT 1`)
  await bench('prisma $transaction (BEGIN, SELECT 1, COMMIT)', 1000, () => prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT 1` }))
  await bench('prisma tx + 5 queries', 500, () => prisma.$transaction(async (tx) => { for (let k = 0; k < 5; k++) await tx.$queryRaw`SELECT 1` }))
  await bench('prisma findUnique(user by email)', 1000, (i) => prisma.user.findUnique({ where: { email: `load${(i % 1000) + 1}@load.test` } }).catch(() => null))
  const pg = new Client({ connectionString: url.split('?')[0] }); await pg.connect()
  await bench('node-postgres SELECT 1', 5000, () => pg.query('SELECT 1'))
  await bench('node-postgres BEGIN/SELECT/COMMIT', 2000, async () => { await pg.query('BEGIN'); await pg.query('SELECT 1'); await pg.query('COMMIT') })
  await pg.end(); await prisma.$disconnect()
})().catch((e) => console.log('ERR', e.message))
