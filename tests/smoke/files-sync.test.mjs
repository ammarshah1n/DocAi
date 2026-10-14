import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const src = await readFile(new URL('../../src/panels/FilesPanel.tsx', import.meta.url), 'utf8');
const code = src.slice(src.indexOf('// <classify>'), src.indexOf('// </classify>'));
const { classifyRemote } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(code)).toString('base64')}`);
const known = { modifiedAt: 't1', revision: 'r1' };
test('classifyRemote never reloads over a dirty draft', () => {
  assert.equal(classifyRemote({ status: 'ready', modifiedAt: 't1', revision: 'r1' }, known, true), 'same');
  assert.equal(classifyRemote({ status: 'ready', modifiedAt: 't2', revision: 'r2' }, known, false), 'reload');
  assert.equal(classifyRemote({ status: 'ready', modifiedAt: 't2', revision: 'r2' }, known, true), 'conflict');
  assert.equal(classifyRemote({ status: 'missing' }, known, true), 'missing');
  assert.equal(classifyRemote({ status: 'error', error: 'x' }, known, false), 'error');
});
