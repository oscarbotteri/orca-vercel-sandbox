import { UserError } from './errors.ts'
import { BUNDLE_REF, type CheckoutSource } from './git-bundle.ts'
import { shellQuote } from './install.ts'
import type { SandboxSession } from './sandbox-session.ts'
import type { SandboxIdentity } from './sandbox-ssh.ts'

export function checkoutPath(identity: SandboxIdentity, source: CheckoutSource): string {
  return `${identity.home}/work/${source.repoName}`
}

// Unpacks the bundle into ~/work/<repo>, on Orca's branch or detached at its commit. Only git
// data goes in: no credential, and `origin` is an HTTPS URL that holds none.
export async function checkoutBundle(
  session: SandboxSession,
  identity: SandboxIdentity,
  source: CheckoutSource,
): Promise<string> {
  const target = checkoutPath(identity, source)
  const bundle = `${identity.home}/checkout.bundle`
  const repo = shellQuote(target)
  await session.writeFile(bundle, source.bundle, 0o600)
  try {
    await session.exec(`git init --quiet ${repo}`)
    await session.exec(`git -C ${repo} fetch --quiet ${shellQuote(bundle)} ${BUNDLE_REF}`)
  } finally {
    await session.exec(`rm -f ${shellQuote(bundle)}`).catch(() => '')
  }
  const checkout = source.branch ? `-B ${shellQuote(source.branch)}` : '--detach'
  await session.exec(`git -C ${repo} checkout --quiet ${checkout} FETCH_HEAD`)
  await session.exec(`git -C ${repo} config user.name ${shellQuote(source.gitName)}`)
  await session.exec(`git -C ${repo} config user.email ${shellQuote(source.gitEmail)}`)
  if (source.originUrl) {
    await session.exec(`git -C ${repo} remote add origin ${shellQuote(source.originUrl)}`)
  }
  const head = (await session.exec(`git -C ${repo} rev-parse HEAD`)).trim()
  if (head !== source.commit) {
    throw new UserError(`the sandbox checkout is at ${head}, not Orca's commit ${source.commit}`)
  }
  return target
}
