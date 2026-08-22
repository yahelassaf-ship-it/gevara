const syncDb = require('../sync-db');

syncDb.applyOperations([{
  opId: 'durable-backend-required',
  collection: 'persons',
  recordId: 'durable-check',
  type: 'upsert',
  baseRevision: 0,
  payload: { name: 'اختبار الاستمرارية' },
}], 'test').then(
  () => process.exitCode = 2,
  (error) => process.exitCode = error?.code === 'DURABLE_SYNC_UNAVAILABLE' ? 0 : 1,
);
