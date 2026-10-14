import test from 'node:test';
import assert from 'node:assert/strict';
import { distribute, CONTENT_HEIGHT } from '../../src/doc/pagination.ts';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const reducerFile = await readFile(new URL('../../src/state/paseo.ts', import.meta.url), 'utf8');
const reducer = reducerFile.slice(reducerFile.indexOf('export function applyItem'), reducerFile.indexOf('const timelines ='));
const { applyItem } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(reducer)).toString('base64')}`);

test('pagination keeps every fragment in order without overflowing normal sheets', () => {
  const items = Array.from({ length: 500 }, (_, id) => ({ id, height: 20 + id % 93 }));
  const pages = distribute(items);
  assert.deepEqual(pages.flat(), items);
  for (const page of pages) assert(page.reduce((sum, item) => sum + item.height, 0) <= CONTENT_HEIGHT);
});
test('stream reducer merges deltas, preserves finished blocks and tool lifecycle detail', () => {
  const user = { kind: 'user', text: 'Hello' };
  let blocks = applyItem([user], { type: 'assistant_message', text: '# Hi' });
  blocks = applyItem(blocks, { type: 'assistant_message', text: '\nThere' });
  assert.equal(blocks[0], user);
  assert.equal(blocks[1].text, '# Hi\nThere');
  blocks = applyItem(blocks, { type: 'tool_call', callId: 'tool-1', name: 'Read', status: 'running', detail: { filePath: '/tmp/test' } });
  blocks = applyItem(blocks, { type: 'tool_call', callId: 'tool-1', status: 'completed' });
  assert.equal(blocks.length, 3);
  assert.equal(blocks[2].name, 'Read');
  assert.equal(blocks[2].item.detail.filePath, '/tmp/test');
  assert.equal(blocks[2].status, 'completed');
  assert.equal(applyItem(blocks, { type: 'unrecognised' }), blocks);
  let cut = applyItem([user], { type: 'assistant_message', messageId: 'msg_1', text: 'from can' });
  for (const text of ['dles to oil', ' lamps to']) cut = applyItem(cut, { type: 'assistant_message', messageId: 'synthetic-message-1', text });
  cut = applyItem(cut, { type: 'assistant_message', messageId: 'msg_1', text: 'dles to oil lamps to' });
  assert.equal(cut.at(-1).text, 'from candles to oil lamps to', 'cancel tail is not duplicated');
  let two = applyItem([user], { type: 'assistant_message', messageId: 'msg_a', text: 'Riv' });
  two = applyItem(two, { type: 'assistant_message', messageId: 'msg_a', text: 'ers' });
  two = applyItem(two, { type: 'assistant_message', messageId: 'msg_b', text: 'sched ok' });
  assert.deepEqual(two.slice(1).map((b) => b.text), ['Rivers', 'sched ok'], 'a new message without a user prompt is its own block');
  let todos = applyItem([user], { type: 'todo', items: [{ text: 'alpha', completed: false }] });
  todos = applyItem(todos, { type: 'todo', items: [{ text: 'alpha', completed: true }, { text: 'beta', completed: false }] });
  assert.equal(todos.filter((b) => b.kind === 'todo').length, 1, 'todo updates replace the turn list');
  assert.equal(todos.at(-1).items[0].completed, true);
});
test('empty document and a full sheet both leave a composer page', () => {
  assert.deepEqual(distribute([]), [[]]);
  const item = { height: CONTENT_HEIGHT };
  assert.deepEqual(distribute([item]), [[item], []]);
});
