import test from "node:test";
import assert from "node:assert/strict";

import { applyOperations, createEmptySyncDatabase, getBootstrap } from "../lib/sync-store.mjs";

test("يحفظ السجل بإصدار متزايد ويعيده في علامة المزامنة", () => {
  const database = createEmptySyncDatabase();
  const result = applyOperations(database, [{ opId: "create-1", collection: "persons", recordId: "p-1", type: "upsert", baseRevision: 0, payload: { name: "اختبار" } }], "server-user");
  assert.equal(result.results[0].status, "accepted");
  assert.equal(result.results[0].record.revision, 1);
  assert.equal(getBootstrap(database, 0).operations[0].record.payload.name, "اختبار");
});

test("يرفض الكتابة فوق سجل تغيرت نسخته من جهاز آخر", () => {
  const database = createEmptySyncDatabase();
  applyOperations(database, [{ opId: "create-1", collection: "persons", recordId: "p-1", type: "upsert", baseRevision: 0, payload: { name: "الأصل" } }], "first-user");
  const result = applyOperations(database, [{ opId: "stale-update", collection: "persons", recordId: "p-1", type: "upsert", baseRevision: 0, payload: { name: "تعديل متأخر" } }], "second-user");
  assert.equal(result.results[0].status, "conflict");
  assert.equal(result.results[0].record.payload.name, "الأصل");
});

test("يعيد تنفيذ العملية نفسها بأمان دون إنشاء سجل إضافي", () => {
  const database = createEmptySyncDatabase();
  const operation = { opId: "stable-op", collection: "persons", recordId: "p-1", type: "upsert", baseRevision: 0, payload: { name: "واحد" } };
  applyOperations(database, [operation], "user");
  const repeated = applyOperations(database, [operation], "user");
  assert.equal(repeated.results[0].status, "accepted");
  assert.equal(database.sequence, 1);
});
