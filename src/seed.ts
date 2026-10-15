import 'reflect-metadata'
import * as argon2 from 'argon2'
import { PrismaClient } from '@prisma/client'

/**
 * Demo data that mirrors the frontend's mock personas (City University,
 * Engineering, Prof. Rahman, Dr. Karim, Nadia Islam ...). Idempotent: running it
 * twice changes nothing. Uses the SYSTEM role (BYPASSRLS) because seeding is
 * administration, not a tenant request.
 *
 *   npm run seed          every account uses the password below
 */
export const DEMO_PASSWORD = 'Demo-pass-12345'

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000)
type PhaseSeed = [string, number, 'approved' | 'submitted' | 'open' | 'locked' | 'changes_requested']

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW !== 'yes') {
    throw new Error('Refusing to seed a production database (set SEED_ALLOW=yes to override)')
  }
  const url = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_SYSTEM_URL is required')
  const db = new PrismaClient({ datasources: { db: { url } } })
  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })

  const user = (email: string, name: string, extra: Record<string, unknown> = {}) =>
    db.user.upsert({ where: { email }, update: {}, create: { email, name, passwordHash, emailVerifiedAt: new Date(), ...extra } })

  await user('root@projectn.test', 'Platform Owner', { isPlatformAdmin: true })

  const existing = await db.workspace.findFirst({ where: { name: 'City University' } })
  if (existing) {
    console.log('City University already seeded; nothing to do')
    await db.$disconnect()
    return
  }
  const ws = await db.workspace.create({
    data: {
      name: 'City University',
      shortName: 'CityU',
      type: 'institution',
      status: 'active',
      settings: { create: { newSupervisorsCanApprove: false, aiMonthlyBudgetUsd: 150, term: { name: 'Fall 2026', start: day(-50).toISOString().slice(0, 10), end: day(70).toISOString().slice(0, 10) } } },
    },
  })
  const W = ws.id

  const eng = await db.faculty.create({ data: { workspaceId: W, name: 'Engineering' } })
  const sci = await db.faculty.create({ data: { workspaceId: W, name: 'Science' } })
  const cse = await db.department.create({ data: { workspaceId: W, facultyId: eng.id, name: 'Computer Science' } })
  const eee = await db.department.create({ data: { workspaceId: W, facultyId: eng.id, name: 'Electrical' } })
  const phy = await db.department.create({ data: { workspaceId: W, facultyId: sci.id, name: 'Physics' } })

  type RoleSeed = { role: 'institution_admin' | 'dean' | 'head' | 'supervisor' | 'student'; scopeType?: 'faculty' | 'department'; scopeId?: string }
  const join = async (email: string, name: string, roles: RoleSeed[], departmentId?: string, canApprove = false, studentCode?: string) => {
    const u = await user(email, name)
    const m = await db.membership.create({ data: { workspaceId: W, userId: u.id, departmentId, canApprove, studentCode } })
    await db.membershipRole.createMany({ data: roles.map((r) => ({ workspaceId: W, membershipId: m.id, ...r })) })
    return u
  }

  await join('registrar@projectn.test', 'Registrar Office', [{ role: 'institution_admin' }])
  const dean = await join('rahman@projectn.test', 'Prof. Rahman', [{ role: 'dean', scopeType: 'faculty', scopeId: eng.id }, { role: 'supervisor' }], cse.id, true)
  const head = await join('hasan@projectn.test', 'Dr. Hasan', [{ role: 'head', scopeType: 'department', scopeId: cse.id }, { role: 'supervisor' }], cse.id, true)
  const karim = await join('karim@projectn.test', 'Dr. Karim', [{ role: 'supervisor' }], cse.id, true)
  const salma = await join('salma@projectn.test', 'Dr. Salma', [{ role: 'supervisor' }], cse.id, true)
  const zahid = await join('zahid@projectn.test', 'Mr. Zahid', [{ role: 'supervisor' }], eee.id, false)
  await join('nusrat@projectn.test', 'Dr. Nusrat Jahan', [{ role: 'supervisor' }], phy.id, true)
  const students = []
  for (const [i, n] of ['Nadia Islam', 'Rafi Ahmed', 'Tania Akter', 'Imran Hossain', 'Sadia Rahman', 'Farhan Kabir'].entries()) {
    students.push(await join(`student${i + 1}@projectn.test`, n, [{ role: 'student' }], cse.id, false, `2021-1-60-0${40 + i}`))
  }

  // Dr. Karim also runs an independent supervision workspace.
  const sw = await db.workspace.create({ data: { name: 'Dr. Karim Supervision', shortName: 'Karim Lab', type: 'supervision', status: 'active', settings: { create: { newSupervisorsCanApprove: true, aiMonthlyBudgetUsd: 10 } } } })
  const km = await db.membership.create({ data: { workspaceId: sw.id, userId: karim.id, canApprove: true } })
  await db.membershipRole.createMany({ data: [{ workspaceId: sw.id, membershipId: km.id, role: 'supervision_owner' }, { workspaceId: sw.id, membershipId: km.id, role: 'supervisor' }] })

  const mkProject = async (title: string, leadId: string, coIds: string[], studentIds: string[], leaderId: string | null, phases: PhaseSeed[]) => {
    const p = await db.project.create({ data: { workspaceId: W, title, departmentId: cse.id, startDate: day(-45), unlockRule: 'on_approval', createdById: dean.id } })
    await db.projectMember.createMany({
      data: [
        { workspaceId: W, projectId: p.id, userId: leadId, role: 'lead' as const },
        ...coIds.map((u) => ({ workspaceId: W, projectId: p.id, userId: u, role: 'co_supervisor' as const })),
        ...studentIds.map((u) => ({ workspaceId: W, projectId: p.id, userId: u, role: 'student' as const, isGroupLeader: u === leaderId })),
      ],
    })
    for (const [i, [name, dueOffset, status]] of phases.entries()) {
      await db.phase.create({
        data: {
          workspaceId: W, projectId: p.id, position: i + 1, name, dueDate: day(dueOffset), status,
          latestVersion: ['approved', 'submitted', 'changes_requested'].includes(status) ? 1 : 0,
          ...(status === 'approved' ? { approvedAt: day(dueOffset - 3), approvedById: leadId, approvedByRole: 'Supervisor' } : {}),
        },
      })
    }
    return p
  }
  await mkProject('Smart Irrigation Controller', karim.id, [salma.id], [students[0].id, students[1].id], students[0].id, [['Proposal', -30, 'approved'], ['Literature review', -5, 'submitted'], ['Prototype', 20, 'locked'], ['Final report', 55, 'locked']])
  await mkProject('Campus Wi-Fi Map', head.id, [], [students[2].id], null, [['Proposal', -20, 'approved'], ['Survey', 2, 'open'], ['Final report', 40, 'locked']])
  await mkProject('Low-power Sensor Network', zahid.id, [], [students[3].id, students[4].id], students[3].id, [['Proposal', -10, 'open'], ['Design', 30, 'locked']])
  await mkProject('Exam Seating Optimiser', salma.id, [karim.id], [students[5].id], null, [['Proposal', -40, 'approved'], ['Implementation', -12, 'changes_requested'], ['Evaluation', 25, 'locked']])

  await db.phaseTemplate.create({
    data: {
      workspaceId: W, name: 'Final-year project',
      items: { create: [{ position: 1, name: 'Proposal', durationDays: 14 }, { position: 2, name: 'Literature review', durationDays: 21 }, { position: 3, name: 'Draft', durationDays: 35 }, { position: 4, name: 'Final report', durationDays: 28 }] },
    },
  })
  await db.job.create({ data: { kind: 'health.sweep', dedupeKey: `seed:health:${Date.now()}` } })

  console.log(`Seeded City University and Dr. Karim Supervision.
Sign in with: root@ (platform owner), registrar@, rahman@ (Dean), hasan@ (Head), karim@, salma@, zahid@, student1@ ... student6@ (all @projectn.test)
Password: ${DEMO_PASSWORD}`)
  await db.$disconnect()
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e)
  process.exit(1)
})
