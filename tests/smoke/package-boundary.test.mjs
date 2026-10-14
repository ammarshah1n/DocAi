import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
test('app packaging excludes private development context and credential files', () => {
  const pattern = pkg.scripts.package.match(/--ignore="([^"]+)"/)?.[1];
  assert(pattern, 'A packaging exclusion rule is required');
  const excluded = new RegExp(pattern);
  for (const path of ['/AGENTS.md', '/CLAUDE.md', '/PLAN.md', '/.pi/state.json', '/.claude/settings.json', '/.env', '/.env.local', '/.npmrc', '/.exec/notes.md', '/.recon-private.md']) {
    assert(excluded.test(path), `Must not package ${path}`);
  }
  for (const path of ['/dist/index.html', '/electron/main.cjs', '/electron/preload.cjs', '/electron/docai.icns', '/package.json', '/THIRD_PARTY_NOTICES.md']) {
    assert(!excluded.test(path), `Must retain ${path}`);
  }
});
