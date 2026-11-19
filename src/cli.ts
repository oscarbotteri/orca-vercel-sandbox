import { run } from './main.ts'

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  readStdin,
  stdout: process.stdout,
  stderr: process.stderr,
})
