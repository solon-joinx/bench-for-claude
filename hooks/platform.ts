import type { EngineInterface } from 'claude-code'

// The hooks runtime has no `process.platform` or `os.homedir()`: the facts
// below are read off the environment instead.

export type Host = {
  /** Windows sets `OS=Windows_NT` for every process. */
  isWindows: boolean
  /** The home folder as Claude Code finds it: USERPROFILE on Windows, else HOME. */
  home: string | undefined
  /** Joins path parts with the host's separator. */
  join: (...parts: string[]) => string
}

export async function host($: EngineInterface): Promise<Host> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = isWindows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
  const separator = isWindows ? '\\' : '/'
  return { isWindows, home, join: (...parts) => parts.join(separator) }
}
