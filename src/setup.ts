import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Command } from './commands.ts'
import { type AdapterHome, resolveHome } from './home.ts'
import { BUNDLE_FILE, installAdapter, removeAdapterFiles } from './install.ts'
import { assertPrerequisites } from './prerequisites.ts'
import { saveSettings, settingsFromFlags } from './settings.ts'
import {
  addIncludeToUserConfig,
  includeLine,
  removeIncludeFromUserConfig,
  userConfigHasInclude,
  userSshConfigPath,
} from './ssh-config.ts'

// Built by `npm run build` from this checkout's sources.
const BUNDLE = join(import.meta.dirname, '..', 'dist', BUNDLE_FILE)

// Records that setup, not the user, added the Include line, so uninstall removes only its own edit.
function includeMarker(home: AdapterHome): string {
  return join(home.root, 'include-added')
}

export const setupCommand: Command = {
  readsPayload: false,
  async run({ args, env, logger, confirm }) {
    // Flags are checked first: a typo should not leave a half-installed adapter.
    const flags = settingsFromFlags(args)
    assertPrerequisites(env)
    const home = resolveHome(env)
    if (args.length > 0) {
      saveSettings(home, flags)
      logger.info(`saved sandbox settings in ${home.config}`)
    }
    installAdapter(home, BUNDLE)
    logger.info(`adapter installed in ${home.root}`)

    const sshConfig = userSshConfigPath(env, homedir())
    const line = includeLine(home.sshConfig)
    if (userConfigHasInclude(sshConfig, line)) {
      logger.info(`${sshConfig} already includes ${home.sshConfig}`)
      return
    }
    const approved = await confirm(`Add "${line}" at the top of ${sshConfig} (a backup is kept)?`)
    if (!approved) {
      logger.info(`left ${sshConfig} unchanged; add "${line}" to it yourself to reach sandboxes`)
      return
    }
    addIncludeToUserConfig(sshConfig, line)
    writeFileSync(includeMarker(home), '', { mode: 0o600 })
    logger.info(`added the Include line to ${sshConfig}`)
  },
}

export const uninstallCommand: Command = {
  readsPayload: false,
  async run({ env, logger }) {
    const home = resolveHome(env)
    if (existsSync(includeMarker(home))) {
      removeIncludeFromUserConfig(userSshConfigPath(env, homedir()), includeLine(home.sshConfig))
      rmSync(includeMarker(home))
    }
    removeAdapterFiles(home)
    logger.info(
      `removed the adapter files and the Include line setup added; keys, state and ssh_config stay in ${home.root}`,
    )
  },
}
