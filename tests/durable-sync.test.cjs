const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('لا يقبل الحفظ المؤقت عندما يُطلب التخزين الدائم', () => {
  const environment = { ...process.env, REQUIRE_DURABLE_SYNC: 'true' };
  delete environment.SUPABASE_URL;
  delete environment.SUPABASE_KEY;
  const result = spawnSync(process.execPath, [path.join(__dirname, 'durable-sync-child.cjs')], { env: environment });
  assert.equal(result.status, 0, result.stderr.toString());
});
