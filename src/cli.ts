import { createInterface } from 'node:readline/promises'
import { run } from './main.ts'

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

// Prompts go to stderr: stdout is reserved for `create`'s JSON result.
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  readStdin,
  confirm,
  stdout: process.stdout,
  stderr: process.stderr,
})
