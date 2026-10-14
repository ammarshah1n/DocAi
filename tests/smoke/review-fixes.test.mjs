import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const moduleOf = code => import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(code)).toString('base64')}#${Math.random()}`);
test('schedule conflict comparison ignores run state but detects editable changes', async () => {
  const source = await readFile(new URL('../../src/panels/SchedulesPanel.tsx', import.meta.url), 'utf8');
  const line = source.split('\n').find(l => l.startsWith('const editSnapshot ='));
  const { editSnapshot } = await moduleOf(`type Schedule = any; export ${line}`);
  const original = { name: 'One', prompt: 'before', cadence: { type: 'cron', expression: '0 0 1 1 *' }, target: { type: 'agent', agentId: 'test' } };
  assert.equal(editSnapshot(original), editSnapshot({ ...original, status: 'paused', nextRunAt: 'later' }));
  for (const patch of [{ name: 'Two' }, { prompt: 'after' }, { cadence: { type: 'every', everyMs: 1000 } }, { target: { type: 'agent', agentId: 'other' } }]) assert.notEqual(editSnapshot(original), editSnapshot({ ...original, ...patch }));
});

test('only the newest provider load may publish success or failure', async () => {
  const source = await readFile(new URL('../../src/doc/DocPage.tsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('  const load = useCallback(() => {'), source.indexOf('  useEffect(() => () => { ++loadSeq.current;', source.indexOf('  const load = useCallback(() => {')));
  const { makeLoad } = await moduleOf(`export function makeLoad(api, scoped, setProviders, setError) { const loadSeq={current:0}; const useCallback=f=>f; const message=e=>e.message; ${body}; return load; }`);
  const pending = [];
  const api = { providers: { snapshot: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } };
  const providers = [], errors = [];
  const load = makeLoad(api, async (_p, models) => models, value => providers.push(value), value => errors.push(value));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  load(); load();
  pending[1].resolve({ entries: [{ provider: 'new', enabled: true, models: [] }] }); await flush();
  pending[0].resolve({ entries: [{ provider: 'old', enabled: true, models: [] }] }); await flush();
  assert.deepEqual(providers.map(v => v[0].provider), ['new']);
  load(); load();
  pending[3].resolve({ entries: [{ provider: 'latest', enabled: true, models: [] }] }); await flush();
  pending[2].reject(new Error('stale failure')); await flush();
  assert(!errors.includes('stale failure'));
});
