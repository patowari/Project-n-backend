import * as client from 'prom-client'

/** Process-wide registry; the HTTP histogram is fed by the metrics middleware. */
export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })
export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
})
export const dbQueries = new client.Counter({ name: 'db_queries_total', help: 'SQL statements issued by the API (enable with DB_QUERY_METRICS=true)', registers: [registry] })
export const dbQuerySeconds = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Statement time as seen by Prisma (enable with DB_QUERY_METRICS=true)',
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
})
export const jobsGauge = new client.Gauge({
  name: 'jobs_queue_depth',
  help: 'Jobs by status (sampled on scrape)',
  labelNames: ['status'] as const,
  registers: [registry],
})

