import { run } from '../../src/main.ts'
import { fakeNetwork } from './fake-network.ts'

// What ssh's ProxyCommand starts in the tests: the adapter's `proxy` command on the process's own
// stdio, with the network redirected to the fake API and the WebSocket bridge named in the env.
const apiUrl = process.env.FAKE_API_URL ?? ''
const bridgePort = Number(process.env.FAKE_BRIDGE_PORT)

process.exitCode = await run(['proxy', process.argv[2] ?? ''], {
  env: process.env,
  readStdin: async () => '',
  confirm: async () => false,
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
  network: fakeNetwork(apiUrl, bridgePort),
  tunnel: { input: process.stdin, output: process.stdout },
  process,
})
