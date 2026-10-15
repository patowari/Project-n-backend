// Run after `prisma migrate deploy`: sets the passwords of the two runtime roles.
// The roles themselves are created by migration 0002 (NOLOGIN-free, NOBYPASSRLS / BYPASSRLS).
//   DATABASE_MIGRATION_URL   owner connection
//   APP_DB_PASSWORD          password for projectn_app    (the API)
//   SYSTEM_DB_PASSWORD       password for projectn_system (workers, Super Admin reports)
const { PrismaClient } = require('@prisma/client')

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`

async function main() {
  const app = process.env.APP_DB_PASSWORD
  const system = process.env.SYSTEM_DB_PASSWORD
  if (!app || !system) throw new Error('APP_DB_PASSWORD and SYSTEM_DB_PASSWORD are required')
  if (app.length < 16 || system.length < 16) throw new Error('Use passwords of at least 16 characters')
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } })
  try {
    await db.$executeRawUnsafe(`ALTER ROLE projectn_app PASSWORD ${lit(app)}`)
    await db.$executeRawUnsafe(`ALTER ROLE projectn_system PASSWORD ${lit(system)}`)
    console.log('runtime role passwords set')
  } finally {
    await db.$disconnect()
  }
}
main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
