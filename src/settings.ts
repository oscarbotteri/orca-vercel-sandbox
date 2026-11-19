import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { UserError } from './errors.ts'
import type { AdapterHome } from './home.ts'

// What new sandboxes are created with; every field is optional and falls back to Vercel's default.
export interface SandboxSettings {
  image?: string
  vcpus?: number
  memoryMb?: number
  timeoutMinutes?: number
  region?: string
}

// Vercel gives each vCPU 2048 MB, so memory is not a separate knob: it must agree with the vCPUs.
const MB_PER_VCPU = 2048

// Vercel offers 1 vCPU or an even count; the ceiling per plan is left to the API to enforce.
const MAX_VCPUS = 32

function isSupportedVcpus(count: number): boolean {
  return count === 1 || (count % 2 === 0 && count <= MAX_VCPUS)
}

export const SETTING_FLAGS = {
  '--image': 'image',
  '--vcpus': 'vcpus',
  '--memory-mb': 'memoryMb',
  '--timeout-minutes': 'timeoutMinutes',
  '--region': 'region',
} as const satisfies Record<string, keyof SandboxSettings>

const TEXT_FIELDS = ['image', 'region'] as const
const NUMBER_FIELDS = ['vcpus', 'memoryMb', 'timeoutMinutes'] as const
const KNOWN = new Set<string>([...TEXT_FIELDS, ...NUMBER_FIELDS])

function positiveInteger(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new UserError(`${field} must be a positive whole number, got ${JSON.stringify(value)}`)
  }
  return value
}

function plainText(field: string, value: unknown): string {
  if (typeof value !== 'string' || !/^[\w./:@-]+$/.test(value)) {
    throw new UserError(
      `${field} must be text without spaces (letters, digits and . / : @ _ -), got ${JSON.stringify(value)}`,
    )
  }
  return value
}

// Checks every field and the way they combine, so a bad value fails here and not as an API error.
export function parseSettings(raw: unknown, source: string): SandboxSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UserError(`${source} must hold a JSON object of settings`)
  }
  const unknown = Object.keys(raw).filter((key) => !KNOWN.has(key))
  if (unknown.length > 0) {
    throw new UserError(`${source}: unknown setting ${unknown.join(', ')}`)
  }
  const fields = raw as Record<string, unknown>
  const settings: SandboxSettings = {}
  try {
    for (const field of TEXT_FIELDS) {
      if (fields[field] !== undefined) settings[field] = plainText(field, fields[field])
    }
    for (const field of NUMBER_FIELDS) {
      if (fields[field] !== undefined) settings[field] = positiveInteger(field, fields[field])
    }
    if (settings.memoryMb !== undefined && settings.memoryMb % MB_PER_VCPU !== 0) {
      throw new UserError(`memoryMb must be a multiple of ${MB_PER_VCPU} (2048 MB per vCPU)`)
    }
    const { vcpus, memoryMb } = settings
    if (vcpus !== undefined && memoryMb !== undefined && memoryMb !== vcpus * MB_PER_VCPU) {
      throw new UserError(`memoryMb ${memoryMb} does not match ${vcpus} vCPUs (2048 MB per vCPU)`)
    }
    const effective = vcpus ?? (memoryMb === undefined ? undefined : memoryMb / MB_PER_VCPU)
    if (effective !== undefined && !isSupportedVcpus(effective)) {
      throw new UserError(
        `${effective} vCPUs is not supported: use 1 or an even number up to ${MAX_VCPUS}`,
      )
    }
  } catch (error) {
    if (error instanceof UserError) throw new UserError(`${source}: ${error.message}`)
    throw error
  }
  return settings
}

export function readSettings(home: AdapterHome): SandboxSettings {
  if (!existsSync(home.config)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(home.config, 'utf8'))
  } catch {
    throw new UserError(`${home.config} is not valid JSON`)
  }
  return parseSettings(raw, home.config)
}

// Flags are numbers on the command line too: a non-numeric one is rejected by the parser above.
export function settingsFromFlags(args: string[]): SandboxSettings {
  const raw: Record<string, unknown> = {}
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] as string
    const field = (SETTING_FLAGS as Record<string, string | undefined>)[flag]
    if (!field) throw new UserError(`unknown option ${flag}`)
    const value = args[i + 1]
    if (value === undefined) throw new UserError(`${flag} needs a value`)
    raw[field] = (NUMBER_FIELDS as readonly string[]).includes(field) ? Number(value) : value
  }
  return parseSettings(raw, 'setup flags')
}

// Flags override what config.json already holds; the merged result is validated as a whole.
export function saveSettings(home: AdapterHome, flags: SandboxSettings): SandboxSettings {
  const merged = parseSettings({ ...readSettings(home), ...flags }, home.config)
  writeFileSync(home.config, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  return merged
}

// The Vercel create parameters these settings stand for.
export function toCreateParams(settings: SandboxSettings): {
  image?: string
  region?: string
  timeout?: number
  resources?: { vcpus: number }
} {
  const vcpus = settings.vcpus ?? (settings.memoryMb ? settings.memoryMb / MB_PER_VCPU : undefined)
  return {
    ...(settings.image && { image: settings.image }),
    ...(settings.region && { region: settings.region }),
    ...(settings.timeoutMinutes && { timeout: settings.timeoutMinutes * 60_000 }),
    ...(vcpus && { resources: { vcpus } }),
  }
}
