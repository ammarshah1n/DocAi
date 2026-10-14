import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const main = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
function nativeLinks(devUrl) {
  const opened = [], events = new Map();
  let popup;
  const electron = {
    shell: { openExternal: async url => { opened.push(url); } },
    ipcMain: { handle() {} },
    BrowserWindow: class {
      constructor() { this.webContents = { on: (name, fn) => events.set(name, fn), setWindowOpenHandler: fn => { popup = fn; } }; }
      once() {} on() {} loadFile() {} loadURL() {}
    },
    app: { whenReady: () => ({ then: fn => fn() }), on() {} },
    session: { defaultSession: { webRequest: { onBeforeSendHeaders() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
  };
  vm.runInNewContext(main, { URL, require: name => name === 'electron' ? electron : require(name), process: { env: { DOCAI_DEV_URL: devUrl }, platform: 'darwin' }, __dirname: '/test/electron', setTimeout });
  return { opened, popup, navigate: url => { let prevented = false; events.get('will-navigate')({ preventDefault: () => { prevented = true; } }, url); return prevented; } };
}
test('both native navigation routes reject OS protocols, malformed URLs and embedded credentials', () => {
  const b = nativeLinks();
  for (const url of ['file:///tmp/example', 'javascript:alert(1)', 'data:text/html,test', 'smb://example.test/share', 'vscode://file/example', 'not a URL', 'https://user:password@example.test']) {
    assert.equal(b.popup({ url }).action, 'deny');
    assert.equal(b.navigate(url), true);
  }
  assert.equal(b.opened.length, 0);
  assert.equal(b.popup({ url: 'https://example.test/docs' }).action, 'deny');
  assert.equal(b.navigate('http://example.test/docs'), true);
  assert.deepEqual(b.opened, ['https://example.test/docs', 'http://example.test/docs']);
});
test('development navigation trusts the exact origin, not a URL prefix', () => {
  const b = nativeLinks('http://localhost:5199');
  assert.equal(b.navigate('http://localhost:5199/src/main.tsx'), false);
  assert.equal(b.navigate('http://localhost:51990/'), true);
  assert.equal(b.navigate('http://localhost:5199@evil.example/'), true);
  assert.deepEqual(b.opened, ['http://localhost:51990/']);
});
