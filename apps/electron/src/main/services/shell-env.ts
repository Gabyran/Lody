import { runCommandText, type CommandText } from '@lody/shared/node/process'

// GUI-launched apps (macOS launchd, Linux .desktop) inherit a minimal PATH that
// usually omits /usr/local/bin, Homebrew, and editor CLIs (`code`, `cursor`,
// ...). We probe the user's login shell once to recover their real environment
// (most importantly PATH) and reuse it whenever we spawn user-facing commands —
// the embedded CLI as well as "Open in" path launchers — so bare command names
// resolve the same way they do in a terminal.

// Interactive rc files (nvm, conda, oh-my-zsh) can take several seconds on a
// cold login. The bound only stops a shell that never returns: the timeout
// SIGTERMs the shell's whole tree, and an interactive shell ignores SIGTERM,
// so it is SIGKILLed shortly after.
const SHELL_ENV_TIMEOUT_MS = 15_000
// Verbose rc files (`set -x`) write to stderr; that must not fail the probe.
const SHELL_ENV_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

let cachedShellEnvPromise: Promise<NodeJS.ProcessEnv | null> | null = null

function parseNullDelimitedEnv(payload: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {}
  const entries = payload.split('\0')
  for (const entry of entries) {
    if (!entry) continue
    const separatorIndex = entry.indexOf('=')
    if (separatorIndex <= 0) continue
    const key = entry.slice(0, separatorIndex)
    const value = entry.slice(separatorIndex + 1)
    parsed[key] = value
  }
  return parsed
}

function resolveShellEnvCommand(shellPath: string): { command: string; args: string[] } {
  if (shellPath.endsWith('/bash')) {
    return {
      command: shellPath,
      args: ['-ilc', 'source ~/.bashrc >/dev/null 2>&1 || true; env -0']
    }
  }
  if (shellPath.endsWith('/zsh')) {
    return {
      command: shellPath,
      args: ['-ilc', 'env -0']
    }
  }
  return {
    command: shellPath,
    args: ['-lc', 'env -0']
  }
}

async function loadUserShellEnv(): Promise<NodeJS.ProcessEnv | null> {
  if (process.platform === 'win32') return null
  if (process.env.LODY_ELECTRON_DISABLE_SHELL_ENV === '1') return null
  const shellPath = process.env.SHELL
  if (!shellPath) return null

  const shellCommand = resolveShellEnvCommand(shellPath)
  let output: CommandText
  try {
    // A timeout ends the shell's whole process tree (rc files may start helpers).
    output = await runCommandText({
      command: shellCommand.command,
      args: shellCommand.args,
      env: process.env,
      timeout: SHELL_ENV_TIMEOUT_MS,
      maxOutputBytes: SHELL_ENV_MAX_OUTPUT_BYTES,
      check: 'none'
    })
  } catch (error) {
    console.warn('Failed to load shell environment', error)
    return null
  }

  if (output.code !== 0) {
    const stderr = output.stderr.trim()
    if (stderr) {
      console.warn(`Shell environment probe exited with code ${output.code}: ${stderr}`)
    } else {
      console.warn(`Shell environment probe exited with code ${output.code}`)
    }
    return null
  }
  const parsed = parseNullDelimitedEnv(output.stdout)
  return Object.keys(parsed).length > 0 ? parsed : null
}

/**
 * Resolve (and cache for the process lifetime) the user's login-shell
 * environment. Returns null on Windows, when disabled, or when the probe fails;
 * callers should fall back to `process.env` in that case. A failed probe is
 * not cached, so a slow cold-login shell is retried on the next call instead
 * of leaving the app with launchd's PATH until it restarts.
 */
export async function getUserShellEnvCached(): Promise<NodeJS.ProcessEnv | null> {
  if (!cachedShellEnvPromise) {
    const probe = loadUserShellEnv()
    cachedShellEnvPromise = probe
    void probe.then((env) => {
      if (env === null && cachedShellEnvPromise === probe) cachedShellEnvPromise = null
    })
  }
  return await cachedShellEnvPromise
}

/**
 * Windows `.cmd`/`.bat` shims (and bare command names that resolve to them)
 * cannot be spawned with `shell:false`. Returns true when the spawn must go
 * through the shell so the shim is found and executed.
 */
export function shouldUseWindowsShell(command: string): boolean {
  if (process.platform !== 'win32') return false
  const normalized = command.trim().toLowerCase()
  if (normalized.endsWith('.cmd') || normalized.endsWith('.bat')) {
    return true
  }
  return (
    !normalized.includes('\\') &&
    !normalized.includes('/') &&
    !normalized.endsWith('.exe') &&
    !normalized.endsWith('.com')
  )
}
