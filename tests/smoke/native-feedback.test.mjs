import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const main = readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');
function bridge(initial) {
  const handlers = new Map(), events = new Map();
  let clipboardImage = initial, reads = 0;
  const sender = { on: (name, fn) => events.set(name, fn), setWindowOpenHandler() {} };
  const electron = {
    clipboard: { readImage: () => { reads++; return clipboardImage; } },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: class { constructor() { this.webContents = sender; } once() {} on() {} loadFile() {} },
    app: { whenReady: () => ({ then: fn => fn() }), on() {} },
    session: { defaultSession: { webRequest: { onBeforeSendHeaders() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
  };
  vm.runInNewContext(main, { require: name => name === 'electron' ? electron : require(name), process: { env: {}, platform: 'darwin' }, __dirname: '/test/electron', setTimeout: () => ({ unref() {} }) });
  const read = () => handlers.get('docai:read-clipboard-image')({ sender });
  return { read, reads: () => reads, set: image => { clipboardImage = image; }, paste: () => events.get('before-input-event')({}, { type: 'keyDown', key: 'v', meta: true }) };
}
const image = data => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }), toPNG: () => Buffer.from(data) });
test('clipboard is unavailable without physical paste and snapshots are one-shot', () => {
  const b = bridge(image('first'));
  assert.equal(b.read(), null);
  assert.equal(b.reads(), 0, 'No clipboard read on startup or unsolicited IPC');
  b.paste(); b.set(image('later'));
  const result = b.read();
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.data, Buffer.from('first').toString('base64'), 'Do not read a later clipboard');
  assert.equal(b.read(), null, 'Only one consumption per paste');
});
test('clipboard snapshots handle empty images and bound dimensions and PNG size', () => {
  for (const [value, error] of [
    [{ isEmpty: () => true }, null],
    [{ isEmpty: () => false, getSize: () => ({ width: 10000, height: 10000 }) }, /too large/],
    [{ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => Buffer.alloc(20 * 1024 * 1024 + 1) }, /20 MB/],
  ]) { const b = bridge(value); b.paste(); if (error) assert.throws(b.read, error); else assert.equal(b.read(), null); }
});
test('preload exposes only a narrow clipboard snapshot read', async () => {
  let exposed; const calls = [];
  vm.runInNewContext(preload, { require: () => ({ contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'docai'); exposed = api; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(null); } } }) });
  assert.equal(calls.length, 0);
  await exposed.readClipboardImage();
  assert.equal(calls[0][0], 'docai:read-clipboard-image');
  assert.deepEqual(Object.keys(exposed).sort(), ['piEnabledModels', 'pickFolder', 'readClipboardImage']);
});
