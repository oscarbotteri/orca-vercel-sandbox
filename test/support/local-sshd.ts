import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

const SSHD_CANDIDATES = ['/usr/sbin/sshd', '/usr/local/sbin/sshd', '/opt/homebrew/sbin/sshd']

function sshdPath(): string | undefined {
  return SSHD_CANDIDATES.find(
    (path) => spawnSync(path, ['-V'], { stdio: 'ignore' }).error === undefined,
  )
}

export function sshdAvailable(): boolean {
  return (
    sshdPath() !== undefined &&
    spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined
  )
}

export interface LocalSshd {
  host: string
  port: number
  user: string
  // Private key the server trusts, and one it does not.
  clientKey: string
  strangerKey: string
  // Trusts one more public key, as a sandbox's authorized_keys does once create has written it.
  authorizeKey(publicKey: string): void
  sshArgs(identity?: string): string[]
  stop(): Promise<void>
}

function keygen(path: string): void {
  const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path])
  if (result.status !== 0) throw new Error(`ssh-keygen failed: ${result.stderr}`)
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function waitForPort(port: number, child: ChildProcess, log: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`sshd exited early:\n${log()}`)
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.destroy()
        resolve(true)
      })
      socket.on('error', () => resolve(false))
    })
    if (open) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`sshd did not start:\n${log()}`)
}

// An unprivileged sshd on 127.0.0.1 that only accepts a freshly generated key for the current
// user: the offline stand-in for the sandbox's sshd. Callers reach it with `ssh ...sshArgs()`.
export async function startLocalSshd(): Promise<LocalSshd> {
  const binary = sshdPath()
  if (!binary) throw new Error('no sshd on this machine')
  const dir = mkdtempSync(join(tmpdir(), 'local-sshd-'))
  const hostKey = join(dir, 'host_key')
  const clientKey = join(dir, 'client_key')
  const strangerKey = join(dir, 'stranger_key')
  for (const key of [hostKey, clientKey, strangerKey]) keygen(key)
  const authorized = join(dir, 'authorized_keys')
  copyFileSync(`${clientKey}.pub`, authorized)

  const port = await freePort()
  const config = join(dir, 'sshd_config')
  writeFileSync(
    config,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKey}`,
      `AuthorizedKeysFile ${authorized}`,
      `PidFile ${join(dir, 'sshd.pid')}`,
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes',
      'UsePAM no',
      'StrictModes no',
      '',
    ].join('\n'),
  )

  const child = spawn(binary, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] })
  let output = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk
  })
  try {
    await waitForPort(port, child, () => output)
  } catch (error) {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
    throw error
  }

  const user = userInfo().username
  return {
    host: '127.0.0.1',
    port,
    user,
    clientKey,
    strangerKey,
    authorizeKey: (publicKey) => appendFileSync(authorized, `${publicKey.trim()}\n`),
    sshArgs: (identity = clientKey) => [
      '-F',
      'none',
      '-i',
      identity,
      '-p',
      String(port),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      `UserKnownHostsFile=${join(dir, 'known_hosts')}`,
      '-o',
      'LogLevel=ERROR',
      `${user}@127.0.0.1`,
    ],
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('close', () => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
        child.kill()
      }),
  }
}
