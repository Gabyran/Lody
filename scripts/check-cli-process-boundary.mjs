#!/usr/bin/env node

// Every OS process the CLI, the desktop main process, the CLI supervisor and the
// shared Node helpers start, wait for or signal goes through the Effect process
// layer (`@lody/shared/node/process`). This guard fails when their source
// reaches for child_process, cross-spawn, node-pty or process.kill directly, so
// a second process implementation cannot creep back in.
// Rules: apps/cli/src/platform/AGENTS.md.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = [
  'apps/cli/src/',
  'apps/electron/src/main/',
  'packages/cli-supervisor/src/',
  'packages/shared/src/node/',
];

/** Files allowed to reach the OS directly, each with the reason it is not a second implementation. */
const allowlist = new Map([
  ['packages/shared/src/node/process.ts', 'the process layer and its single OS boundary'],
  [
    'packages/shared/src/node/process-testing.ts',
    'test support that models the OS process table; imported only by tests',
  ],
  [
    'apps/cli/src/lib/terminal-pty-service.ts',
    'loads node-pty, the only PTY spawner; PTY trees end through the process layer',
  ],
  [
    'apps/cli/src/lib/github-git-transport.ts',
    'source text of a standalone git wrapper script that runs in its own process',
  ],
  [
    'apps/cli/src/lib/gh-shim-script.ts',
    'source text of a standalone gh shim script that runs in its own process',
  ],
  [
    'apps/cli/src/lib/git-credential-helper-script.ts',
    'source text of a standalone credential helper that runs in its own process',
  ],
  [
    'apps/cli/src/agent/deepseek-harness-runtime.ts',
    'source text injected into the DeepSeek Harness child, not daemon code',
  ],
]);

const forbidden = [
  {
    // Type-only imports carry no behaviour and stay allowed.
    pattern: /import\s+(?!type\b)[^;]*?from\s+['"](?:node:)?child_process['"]/gu,
    label: 'child_process import',
  },
  { pattern: /require\(\s*['"](?:node:)?child_process['"]\s*\)/gu, label: 'child_process require' },
  { pattern: /from\s+['"]cross-spawn['"]/gu, label: 'cross-spawn import' },
  { pattern: /['"](?:@lydell\/)?node-pty['"]/gu, label: 'node-pty reference' },
  { pattern: /\bprocess\.kill\s*\(/gu, label: 'process.kill call' },
  // Signalling a ChildProcess (or PTY) directly is a hand-written termination
  // path; `terminateTree` owns escalation and bounded waits. The `NodeProcess`
  // service's own `kill` is the sanctioned door.
  {
    pattern: /\b([\w$]+)\.kill\s*\(/gu,
    label: 'direct child signal',
    skip: (match) => ['process', 'np', 'nodeProcess', 'nodeProcessLive'].includes(match[1] ?? ''),
  },
];

async function listSources() {
  const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', ...sourceRoots], {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .filter((file) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(file))
    .filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) && !file.includes('/__tests__/'));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

const violations = [];
for (const file of await listSources()) {
  if (allowlist.has(file)) continue;
  let text;
  try {
    text = await readFile(path.join(repoRoot, file), 'utf8');
  } catch {
    continue;
  }
  for (const { pattern, label, skip } of forbidden) {
    for (const match of text.matchAll(pattern)) {
      if (skip?.(match)) continue;
      violations.push(`${file}:${lineOf(text, match.index ?? 0)} ${label}`);
    }
  }
}

if (violations.length > 0) {
  console.error('Process boundary violations (use @lody/shared/node/process instead):');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log('Process boundary guard passed.');
