import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../../src/doc/DocPage.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../../src/doc/doc.css', import.meta.url), 'utf8');

test('composer stays discoverable without simulated or stolen focus', () => {
  assert.match(page, /placeholder=\{running \? "Write a follow-up…" : "Write a message…"\}/);
  assert.match(page, /role="status"/);
  assert.match(css, /\.doc-composer textarea[^}]*border-bottom: 1px solid/);
  assert.doesNotMatch(page, /doc-stream-caret|input\.current\?\.focus\(/);
  assert.doesNotMatch(page, /createPortal|appendChild\(tail\)|composerFocus/);
  assert.match(page, /<Composer key="composer"/);
  assert.match(page, /readOnly=\{sending\}/);
  assert.match(page, /sending \|\| pendingPastes\.current/);
});

test('paste handles DOM image files and only then falls back to the optional native clipboard reader', () => {
  assert.match(page, /clipboard\.items\].filter\(item => item\.type\.startsWith\("image\/"\)\)/);
  assert.match(page, /const text = clipboard\.getData\("text\/plain"\)/);
  assert.match(page, /if \(files\.length\)[\s\S]*?insertText\(\)/);
  assert.match(page, /const readClipboardImage = .*\?\.readClipboardImage;/);
  assert.match(page, /if \(readClipboardImage\)/);
  assert.match(page, /file\.size > 20 \* 1024 \* 1024/);
  assert.match(page, /bytes > 20 \* 1024 \* 1024/);
  assert.match(page, /catch \(err\) \{ retryAction\.current = \(\) => void attach\(read\); setError\(message\(err\)\); \}/);
});

test('agent stream updates do not emit a fake typing caret or force history scrolling', () => {
  assert.doesNotMatch(page, /doc-stream-caret/);
  assert.match(page, /if \(atBottom\.current && el && caret\)/);
});
