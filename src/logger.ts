import { appendFileSync, chmodSync } from 'node:fs'

export interface Logger {
  info(message: string): void
  error(message: string): void
}

export interface Sink {
  write(text: string): void
}

export interface LoggerOptions {
  file: string
  stderr: Sink
  // Exact values (the Vercel token) that must never be written, whatever they sit inside.
  secrets: readonly string[]
}

const REDACTED = '[redacted]'

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(?<=\/\/)[^\s/@:]+:[^\s/@]+(?=@)/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bvc[a-z]_[A-Za-z0-9]{16,}\b/g,
]

export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(REDACTED)
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}

export function createLogger(options: LoggerOptions): Logger {
  function write(level: 'info' | 'error', message: string): void {
    const clean = redact(message, options.secrets)
    appendFileSync(options.file, `${new Date().toISOString()} ${level} ${clean}\n`, { mode: 0o600 })
    // appendFile's mode only applies when it creates the file.
    chmodSync(options.file, 0o600)
    options.stderr.write(`${clean}\n`)
  }
  return {
    info: (message) => write('info', message),
    error: (message) => write('error', message),
  }
}
