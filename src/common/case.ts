/** Wire format is snake_case (architecture 12); the code base is camelCase. */
const toSnake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
const toCamel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())

const isPlain = (v: unknown): v is Record<string, unknown> =>
  Object.prototype.toString.call(v) === '[object Object]'

function walk(v: unknown, f: (k: string) => string): unknown {
  if (Array.isArray(v)) return v.map((x) => walk(x, f))
  if (v instanceof Date) return v
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), walk(x, f)]))
  return v
}

export const snakeizeKeys = <T = unknown>(v: unknown) => walk(v, toSnake) as T
export const camelizeKeys = <T = unknown>(v: unknown) => walk(v, toCamel) as T
export { toSnake, toCamel }
