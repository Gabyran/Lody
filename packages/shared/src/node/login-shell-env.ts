/**
 * The user's login-shell environment, probed once through the process layer.
 *
 * GUI and daemon launches (macOS launchd, Linux .desktop, systemd, npx) inherit
 * a minimal PATH without the directories users install tools into (Homebrew,
 * nvm, volta, `~/.local/bin`, editor CLIs). Both the CLI and the desktop read
 * the login shell's environment to recover them; this is their one probe.
 */
import { userInfo } from 'node:os';

import type { Duration } from 'effect';

import { CommandTimedOut, runCommandText, type ProcessFacadeOptions } from './process';

const DELIMITER = '_LODY_SHELL_ENV_DELIMITER_';
/** Verbose rc files (`set -x`) write to stderr; that must not fail the probe. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** POSIX shells to try when the default one fails (for example Nushell). */
const FALLBACK_SHELLS = ['/bin/zsh', '/bin/bash'];

/**
 * The script each shell runs. `command env` skips aliases and functions named
 * `env`; `-0` keeps values with newlines intact, with plain `env` for one
 * without it (BusyBox); the delimiters separate the environment from whatever
 * the rc files print. Interactive login bash reads `~/.bash_profile` but not
 * `~/.bashrc`, where most PATH edits live.
 */
const probeScript = (shell: string): string =>
  `${shell.endsWith('/bash') ? 'source ~/.bashrc >/dev/null 2>&1 || true; ' : ''}` +
  `echo -n "${DELIMITER}"; command env -0 2>/dev/null || command env; echo -n "${DELIMITER}"; exit`;

/** Keep rc files from blocking the probe (oh-my-zsh auto-update, tmux autostart). */
const PROBE_ENV = {
  DISABLE_AUTO_UPDATE: 'true',
  ZSH_TMUX_AUTOSTARTED: 'true',
  ZSH_TMUX_AUTOSTART: 'false',
};

export const parseLoginShellEnvOutput = (stdout: string): NodeJS.ProcessEnv | null => {
  const section = stdout.split(DELIMITER)[1];
  if (section === undefined) return null;
  const parsed: NodeJS.ProcessEnv = {};
  for (const entry of section.split(section.includes('\0') ? '\0' : '\n')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    parsed[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
};

const defaultShell = (env: NodeJS.ProcessEnv): string => {
  try {
    const { shell } = userInfo();
    if (shell) return shell;
  } catch {
    // No passwd entry (a container user); fall back to the environment.
  }
  return env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
};

export interface LoginShellEnvOptions {
  /** Ends the shell's whole process tree when exceeded; a hung rc file cannot leak it. */
  readonly timeout: Duration.DurationInput;
  /** The environment the shell starts from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to the user's login shell. */
  readonly shell?: string;
  readonly processOptions?: ProcessFacadeOptions;
}

/**
 * Run the login shell interactively and return the environment it ends with,
 * or null (Windows, or no shell produced one). A shell that fails to start or
 * exits unsuccessfully falls back to zsh, then bash; a shell that times out
 * does not, because its rc files are what hung.
 */
export const probeLoginShellEnv = async (
  options: LoginShellEnvOptions
): Promise<NodeJS.ProcessEnv | null> => {
  if (process.platform === 'win32') return null;
  const baseEnv = options.env ?? process.env;
  const first = options.shell ?? defaultShell(baseEnv);
  const shells = [first, ...FALLBACK_SHELLS.filter((shell) => shell !== first)];
  for (const shell of shells) {
    let stdout: string;
    try {
      const output = await runCommandText(
        {
          command: shell,
          args: ['-ilc', probeScript(shell)],
          env: { ...baseEnv, ...PROBE_ENV },
          timeout: options.timeout,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          check: 'exit-0',
        },
        options.processOptions
      );
      stdout = output.stdout;
    } catch (error) {
      if (error instanceof CommandTimedOut) return null;
      continue;
    }
    const parsed = parseLoginShellEnvOutput(stdout);
    if (parsed) return parsed;
  }
  return null;
};
