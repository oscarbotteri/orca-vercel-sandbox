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
  } catch (error) {
    // Ctrl-D or a closed stdin aborts the question: that is a no, not a failure.
    if (error instanceof Error && error.name === 'AbortError') return false
    throw error
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
  cwd: process.cwd(),
  network: { fetch, webSocket: (url) => new WebSocket(url) },
  tunnel: { input: process.stdin, output: process.stdout },
  process,
})
