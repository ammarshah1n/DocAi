import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [tsx, css] = await Promise.all([
  readFile(new URL('../../src/doc/DocPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/doc/doc.css', import.meta.url), 'utf8'),
]);

test('document uses one continuous rendered tree and keeps the composer in it', () => {
  const sheets = tsx.slice(tsx.indexOf('function Sheets('), tsx.indexOf('\nfunction Composer('));
  assert.doesNotMatch(sheets, /createPortal|doc-measure|doc-tail|paginate|splitElement|distribute/);
  assert.equal((sheets.match(/<article\b/g) ?? []).length, 1);
  assert.match(sheets, /<article[^>]*className="doc-sheet doc-text"[\s\S]*\{children\}[\s\S]*<\/article>/);
  assert.match(tsx, /<Composer key="composer"/);
  assert.match(tsx, /<textarea ref=\{input\} aria-label="Write in document"/);
  assert.match(css, /\.doc-sheet\s*\{[^}]*width:\s*816px[^}]*padding:\s*96px/);
  assert.doesNotMatch(css, /\.doc-measure|\.doc-tail|doc-sheet-space/);
});

test('closed reasoning and tool details do not mount or format their bodies', () => {
  assert.match(tsx, /\{open && <Streamdown controls=\{false\}>\{block\.text\}<\/Streamdown>\}/);
  assert.match(tsx, /\{open && <>[\s\S]*pretty\(block\.item\.detail/);
});

test('prompt indexes are assigned once in block order; working status is static', () => {
  const sheets = tsx.slice(tsx.indexOf('function Sheets('), tsx.indexOf('\nfunction Composer('));
  assert.match(sheets, /let promptIndex = 0;[\s\S]*blocks\.map\(\(block, index\) => \{[\s\S]*promptIndex\+\+/);
  assert.doesNotMatch(sheets, /blocks\.slice\(0,/);
  assert.match(tsx, /running \? "Working"/);
  assert.doesNotMatch(css, /doc-working-dots|@keyframes doc-dot/);
});
