const test = require('node:test');
const assert = require('node:assert/strict');
const { createArchiveDocument, listDocuments, upsertArchiveDocument } = require('../public/archive-ledger.js');

test('ينشئ وثيقة أرشيف ثابتة المعرف لإجراء تفقد', () => {
  const document = createArchiveDocument({
    category: 'tafaqud',
    sourceId: 'tfa-1',
    title: 'جدول تفقد — صباحي',
    actionDate: '2026-08-22',
    rows: [{ milId: '101' }],
  });

  assert.equal(document.id, 'archive-tafaqud-tfa-1');
  assert.equal(document.rows.length, 1);
  assert.equal(document.schemaVersion, 1);
});

test('يحدّث الأرشيف عند إعادة اعتماد المصدر نفسه ولا ينشئ تكراراً', () => {
  const documents = [];
  upsertArchiveDocument(documents, { category: 'khasm', sourceId: 'book-1', rows: [{ milId: '201' }] });
  const updated = upsertArchiveDocument(documents, { category: 'khasm', sourceId: 'book-1', rows: [{ milId: '201' }, { milId: '202' }] });

  assert.equal(updated.created, false);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].rows.length, 2);
  assert.equal(listDocuments(documents, 'khasm').length, 1);
});
