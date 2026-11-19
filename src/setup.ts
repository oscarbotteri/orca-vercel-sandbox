import { homedir } from 'node:os'
import type { Command } from './commands.ts'
import { resolveHome } from './home.ts'
import { installAdapter, removeAdapterFiles } from './install.ts'
import { assertPrerequisites } from './prerequisites.ts'
import {
  addIncludeToUserConfig,
  includeLine,
  removeIncludeFromUserConfig,
  userConfigHasInclude,
  userSshConfigPath,
} from './ssh-config.ts'

const SOURCE_DIR = import.meta.dirname

export const setupCommand: Command = {
  readsPayload: false,
  async run({ env, logger, confirm }) {
    assertPrerequisites(env)
    const home = resolveHome(env)
    installAdapter(home, SOURCE_DIR)
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
    logger.info(`added the Include line to ${sshConfig}`)
  },
}

export const uninstallCommand: Command = {
  readsPayload: false,
  async run({ env, logger }) {
    const home = resolveHome(env)
    removeIncludeFromUserConfig(userSshConfigPath(env, homedir()), includeLine(home.sshConfig))
    removeAdapterFiles(home)
    logger.info(
      `removed the Include line and the adapter files; keys and state stay in ${home.root}`,
    )
  },
}
