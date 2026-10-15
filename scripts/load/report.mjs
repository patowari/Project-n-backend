// docs/load-results.json -> markdown tables (printed; pasted into docs/LOAD_TEST.md)
import { readFileSync } from 'node:fs'

const r = JSON.parse(readFileSync('docs/load-results.json', 'utf8'))
const ms = (n) => (n >= 100 ? Math.round(n) : Number(n).toFixed(1))
const row = (s) => `| ${s.title} | ${s.reqPerSec.toLocaleString('en-US')} | ${ms(s.latencyMs.p50)} | ${ms(s.latencyMs.p90)} | ${ms(s.latencyMs.p99)} | ${ms(s.latencyMs.max)} | ${s.non2xx + s.errors + s.timeouts} |`
let md = `Machine: ${r.machine.cpus} logical CPUs (${r.machine.cpu}), ${r.machine.memGb} GB RAM, ${r.machine.platform}, Node ${r.machine.node}, PostgreSQL ${r.postgres}. API, database and load generator share this machine.\nConfig: ${r.config.connections} concurrent connections, ${r.config.durationS} s per scenario, API database pool ${r.config.dbPool}, no Redis (in-process cache).\n\n`
md += '| Scenario | req/s | p50 ms | p90 ms | p99 ms | max ms | failed |\n|---|---:|---:|---:|---:|---:|---:|\n'
for (const s of r.scenarios) md += row(s) + '\n'
md += row(r.mixed) + '\n'
md += `\nLogin (Argon2id, 4 connections): ${r.login.reqPerSec} req/s, p50 ${ms(r.login.latencyMs.p50)} ms, p99 ${ms(r.login.latencyMs.p99)} ms.\n`
md += `\nAPI resident memory after the run: ${r.apiRssMb} MB; database connections held: ${r.dbConnectionsAfter}.\n`
md += '\nCold `GET /reports/summary` (cache miss, 250k-project database): ' + r.cold.map((c) => `${c.ms} ms`).join(', ') + '\n'
if (r.worker) {
  const h = r.worker.healthRecompute
  md += `\nWorker paths (system role): health recompute ${h.projects} projects avg ${h.avgMs} ms (p50 ${h.p50Ms}, p95 ${h.p95Ms}, p99 ${h.p99Ms}). Queue: ${r.worker.queue.jobs} jobs in ${r.worker.queue.seconds} s = ${r.worker.queue.jobsPerSec} jobs/s with ${r.worker.queue.runnersCompeting} competing runners; executed more than once: ${r.worker.queue.executedMoreThanOnce}.\n`
}
md += '\n| Query (as app role, RLS on) | execution ms | planning ms | seq scans on big tables |\n|---|---:|---:|---|\n'
for (const p of r.plans) md += `| ${p.name} | ${p.executionMs} | ${p.planningMs} | ${p.seqScansOnBigTables.join(', ') || 'none'} |\n`
console.log(md)
