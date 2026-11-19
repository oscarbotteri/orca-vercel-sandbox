import { BRIDGE_PORT } from './lifecycle-payload.ts'
import type { SandboxSession } from './sandbox-session.ts'

// Everything the bridge needs lives in /tmp, which survives a stop (ADR 0001).
const DIR = '/tmp/vercel-orca'
const SSHD_CONFIG = `${DIR}/sshd_config`
const WEBSOCAT = `${DIR}/websocat`
const WEBSOCAT_URL =
  'https://github.com/vi/websocat/releases/download/v1.14.0/websocat.x86_64-unknown-linux-musl'

export interface SandboxIdentity {
  user: string
  home: string
}

export async function readIdentity(session: SandboxSession): Promise<SandboxIdentity> {
  const [user, home] = await Promise.all([
    session.exec('id -un'),
    session.exec('printf %s "$HOME"'),
  ])
  return { user: user.trim(), home: home.trim() }
}

function sshdConfig(identity: SandboxIdentity): string {
  return [
    'Port 22',
    // The published URL is public: sshd must only be reachable through the bridge.
    'ListenAddress 127.0.0.1',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'Subsystem sftp /usr/lib/openssh/sftp-server',
    `AllowUsers ${identity.user}`,
    `AuthorizedKeysFile ${identity.home}/.ssh/authorized_keys`,
    '',
  ].join('\n')
}

// Installs sshd and websocat once and trusts the one public key. Only the public key is sent.
export async function installSshBridge(
  session: SandboxSession,
  identity: SandboxIdentity,
  publicKey: string,
): Promise<void> {
  await session.exec(
    'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server',
    { sudo: true },
  )
  await session.exec('ssh-keygen -A', { sudo: true })
  await session.exec(
    `mkdir -p ${DIR} ${identity.home}/work ${identity.home}/.ssh && chmod 700 ${identity.home}/.ssh`,
  )
  await session.writeFile(SSHD_CONFIG, sshdConfig(identity), 0o644)
  await session.writeFile(`${identity.home}/.ssh/authorized_keys`, `${publicKey}\n`, 0o600)
  await session.exec(`curl -fsSL -o ${WEBSOCAT} ${WEBSOCAT_URL} && chmod 755 ${WEBSOCAT}`)
}

// Processes do not survive a stop, so wake runs this again; nothing is installed here.
export async function startSshBridge(session: SandboxSession): Promise<void> {
  await session.exec(`mkdir -p /run/sshd && /usr/sbin/sshd -f ${SSHD_CONFIG}`, { sudo: true })
  await session.exec(
    `nohup ${WEBSOCAT} --binary ws-l:0.0.0.0:${BRIDGE_PORT} tcp:127.0.0.1:22 >/dev/null 2>&1 &`,
    { background: true },
  )
}
