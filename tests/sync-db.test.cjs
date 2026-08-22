const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.DATA_DIR = path.join('/tmp', 'five66-iqz9-sync-db-tests');
process.env.REQUIRE_DURABLE_SYNC = 'false';
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const syncDb = require('../sync-db');

test('يقبل التحديث الدقيق ثم يعيد تعارضاً عند استخدام نسخة قديمة', async () => {
  const unique = String(Date.now());
  const created = await syncDb.applyOperations([{
    opId: `db-create-${unique}`,
    collection: 'persons',
    recordId: `person-${unique}`,
    type: 'upsert',
    baseRevision: 0,
    payload: { name: 'سجل تكامل' },
  }], 'integration-user');

  assert.equal(created.results[0].status, 'accepted');
  assert.equal(created.results[0].record.revision, 1);

  const conflict = await syncDb.applyOperations([{
    opId: `db-conflict-${unique}`,
    collection: 'persons',
    recordId: `person-${unique}`,
    type: 'upsert',
    baseRevision: 0,
    payload: { name: 'تعديل قديم' },
  }], 'second-user');

  assert.equal(conflict.results[0].status, 'conflict');
  const bootstrap = await syncDb.bootstrap(0);
  assert.ok(bootstrap.operations.some((operation) => operation.record?.id === `person-${unique}`));
});


test('يعيد علامة متابعة صحيحة عند تجاوز نتائج bootstrap حد الصفحة', async () => {
  const unique = String(Date.now());
  const operations = Array.from({ length: 501 }, (_, index) => ({
    opId: `page-${unique}-${index}`,
    collection: 'pagination',
    recordId: `record-${unique}-${index}`,
    type: 'upsert',
    baseRevision: 0,
    payload: { index },
  }));

  for (let offset = 0; offset < operations.length; offset += 100) {
    const result = await syncDb.applyOperations(operations.slice(offset, offset + 100), 'pagination-user');
    assert.equal(result.results.length, Math.min(100, operations.length - offset));
    assert.ok(result.results.every((item) => item.status === 'accepted'));
  }

  const firstPage = await syncDb.bootstrap(0);
  assert.equal(firstPage.operations.length, 500);
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.serverSequence, firstPage.operations.at(-1).sequence);

  const secondPage = await syncDb.bootstrap(firstPage.serverSequence);
  assert.equal(secondPage.hasMore, false);
  assert.ok(secondPage.operations.length >= 1);
  assert.ok(secondPage.operations.every((operation) => operation.sequence > firstPage.serverSequence));
});
