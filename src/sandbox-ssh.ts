import { UserError } from './errors.ts'
import { BRIDGE_PORT } from './lifecycle-payload.ts'
import type { SandboxSession } from './sandbox-session.ts'

// Everything the bridge needs lives in /tmp, which survives a stop (ADR 0001).
const DIR = '/tmp/vercel-orca'
const SSHD_CONFIG = `${DIR}/sshd_config`
const WEBSOCAT = `${DIR}/websocat`
const BRIDGE_LOG = `${DIR}/websocat.log`
const SSHD_LOG = `${DIR}/sshd.log`
// Pinned: the project publishes no checksums, so this is the hash of the v1.14.0 asset as downloaded.
const WEBSOCAT_SHA256 = '33a80fcbf2313e3c6e816ddafec333c1a04cc34464d4ba4970d938275775a12f'
const WEBSOCAT_URL =
  'https://github.com/vi/websocat/releases/download/v1.14.0/websocat.x86_64-unknown-linux-musl'

export interface SandboxIdentity {
  user: string
  home: string
}

const SAFE_USER = /^[a-z_][a-z0-9_-]*$/i
const SAFE_HOME = /^\/[\w./-]+$/

// Both end up in shell commands and in sshd_config, which quote differently, so anything but
// plain names and paths is refused instead of escaped.
export async function readIdentity(session: SandboxSession): Promise<SandboxIdentity> {
  const [user, home] = (
    await Promise.all([session.exec('id -un'), session.exec('printf %s "$HOME"')])
  ).map((value) => value.trim()) as [string, string]
  if (!SAFE_USER.test(user) || !SAFE_HOME.test(home)) {
    throw new UserError(`unexpected user or home in the sandbox: ${JSON.stringify({ user, home })}`)
  }
  return { user, home }
}

// What websocat said, to explain a bridge that never came up. It holds no secrets.
export async function readBridgeLog(session: SandboxSession): Promise<string> {
  const [bridge, sshd] = await Promise.all(
    [BRIDGE_LOG, SSHD_LOG].map((log) => session.exec(`tail -n 20 ${log} 2>/dev/null || true`)),
  )
  return [bridge, sshd ? `sshd:\n${sshd.trim()}` : ''].join('\n').trim()
}

function sshdConfig(identity: SandboxIdentity): string {
  return [
    'Port 22',
    // Says why sshd refuses a key (bad ownership or modes, a locked account) in sshd.log.
    'LogLevel VERBOSE',
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
  // A custom image may not be Debian or Ubuntu; say so now rather than as an apt-get error.
  await session.exec('command -v apt-get >/dev/null').catch((error: unknown) => {
    // Only a failed command means a missing apt-get; an API or network error must surface as is.
    if (!(error instanceof UserError)) throw error
    throw new UserError(
      'the sandbox image has no apt-get: only Debian and Ubuntu based images are supported',
    )
  })
  await session.exec(
    'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server',
    { sudo: true },
  )
  await session.exec('ssh-keygen -A', { sudo: true })
  // The sandbox user's account is locked (password "!"), and sshd refuses a locked account even
  // for a key. "*" is no password at all, which sshd accepts and which still cannot log in by one.
  await session.exec(`usermod -p '*' ${identity.user}`, { sudo: true })
  await session.exec(
    `mkdir -p ${DIR} ${identity.home}/work ${identity.home}/.ssh && chmod 700 ${identity.home}/.ssh`,
  )
  await session.writeFile(SSHD_CONFIG, sshdConfig(identity), 0o644)
  await session.writeFile(`${identity.home}/.ssh/authorized_keys`, `${publicKey}\n`, 0o600)
  // The binary carries the SSH traffic: run it only if it is the pinned build for this machine.
  await session.exec(
    `[ "$(uname -m)" = x86_64 ] || { echo "websocat is pinned for x86_64, not $(uname -m)" >&2; exit 1; }; ` +
      `curl -fsSL -o ${WEBSOCAT} ${WEBSOCAT_URL} && ` +
      `echo "${WEBSOCAT_SHA256}  ${WEBSOCAT}" | sha256sum -c - && chmod 755 ${WEBSOCAT}`,
  )
}

// Processes do not survive a stop, so wake runs this again; nothing is installed here. Each
// process starts only if it is not already running, so a second wake finds nothing to do.
export async function startSshBridge(session: SandboxSession): Promise<void> {
  await session.exec(
    `pgrep -x sshd >/dev/null || { mkdir -p /run/sshd && /usr/sbin/sshd -f ${SSHD_CONFIG} -E ${SSHD_LOG}; }`,
    { sudo: true },
  )
  // The trailing & backgrounds the whole `||` list, so a running bridge is left alone.
  await session.exec(
    `pgrep -x websocat >/dev/null || ` +
      `nohup ${WEBSOCAT} --binary --exit-on-eof ws-l:0.0.0.0:${BRIDGE_PORT} tcp:127.0.0.1:22 >${BRIDGE_LOG} 2>&1 &`,
    { background: true },
  )
}
