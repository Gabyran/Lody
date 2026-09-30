import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { parseSessionLink } from '../packages/shared/src/session-link.ts';
import { getDesktopCallbackProtocol } from '../apps/electron/src/main/desktop-channel.ts';
import { withDesktopResourceProtocols } from '../apps/electron/scripts/desktop-protocols.mjs';

const require = createRequire(import.meta.url);
function loadMain(file, overrides, processContext) {
  const source = readFileSync(
    new URL(`../apps/electron/src/main/${file}.ts`, import.meta.url),
    'utf8'
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require: (name) => overrides[name] ?? require(name),
    process: processContext,
    URL,
    URLSearchParams,
  });
  return exports;
}

for (const protocol of ['lody', 'lody-oss', 'ai.lody.nightly']) {
  test(`${protocol} accepts common launch resources but not another installation's callbacks`, () => {
    const receiver = loadMain('deep-link-url', {
      './platform': { desktopInstallationProfile: { desktopProtocol: protocol } },
      './desktop-channel': { getDesktopCallbackProtocol },
      '@lody/shared/session-link': { parseSessionLink },
    });
    const link = 'lody://session/Synthetic_A?workspace=workspace_1';
    const quote = String.fromCharCode(34);
    assert.equal(receiver.extractDeepLinkFromArgv(['app', quote + link + quote]), link);
    assert.equal(receiver.parseDeepLinkArg('session://Synthetic_A'), null);
    const callback = `${getDesktopCallbackProtocol({ desktopProtocol: protocol })}://auth/callback#token=synthetic`;
    assert.equal(receiver.parseDeepLinkArg(callback), callback);
    if (protocol !== 'lody')
      assert.equal(receiver.parseDeepLinkArg('lody://auth/callback#token=synthetic'), null);
  });

  test(`${protocol} packaging advertises resources and its own callback only`, () => {
    const config = withDesktopResourceProtocols([{ name: 'Synthetic', schemes: [protocol] }]);
    const schemes = new Set(config.flatMap((entry) => entry.schemes));
    assert.deepEqual(
      schemes,
      new Set(['lody', protocol, getDesktopCallbackProtocol({ desktopProtocol: protocol })])
    );
    assert.deepEqual(withDesktopResourceProtocols(config), config);
  });
}

test('AppImage launch preserves the common default, while explicit selection changes it', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lody-link-registration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const iconPath = join(directory, 'synthetic-icon.png');
  writeFileSync(iconPath, 'synthetic');
  const handlers = new Map([['lody', 'previous.desktop']]);
  const app = {
    isPackaged: true,
    getAppPath: () => directory,
    setAsDefaultProtocolClient: (scheme) => {
      handlers.set(scheme, 'synthetic.desktop');
      return true;
    },
    isDefaultProtocolClient: (scheme) => handlers.get(scheme) === 'synthetic.desktop',
  };
  const receiver = loadMain(
    'protocol-client',
    {
      electron: { app },
      'node:child_process': {
        spawn: (command, args) => {
          if (command === 'xdg-mime') handlers.set(args[2].split('/')[1], args[1]);
          const child = new EventEmitter();
          child.stderr = null;
          queueMicrotask(() => child.emit('close', 0, null));
          return child;
        },
      },
    },
    {
      platform: 'linux',
      execPath: '/synthetic/electron',
      argv: [],
      env: { XDG_DATA_HOME: directory, APPIMAGE: '/synthetic/Lody.AppImage' },
    }
  );
  receiver.registerLodyProtocolClient({
    protocol: 'lody-oss',
    productName: 'Synthetic',
    desktopFileName: 'synthetic.desktop',
    iconPath,
    log: () => {},
  });
  assert.equal(handlers.get('lody'), 'previous.desktop');
  assert.equal(handlers.get('lody-oss'), 'synthetic.desktop');
  const desktop = readFileSync(join(directory, 'applications/synthetic.desktop'), 'utf8');
  assert.match(desktop, /MimeType=x-scheme-handler\/lody-oss;x-scheme-handler\/lody;/);
  assert.equal(receiver.isDefaultLodyProtocolClient(), false);
  receiver.setDefaultLodyProtocolClient();
  assert.equal(receiver.isDefaultLodyProtocolClient(), true);
  assert.equal(handlers.get('lody-oss'), 'synthetic.desktop');
});
