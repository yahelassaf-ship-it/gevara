const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function response(payload) {
  return { ok: true, json: async () => payload };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message || 'انتهت مهلة انتظار الاختبار');
}

test('يحدّث أساس العملية المحلية الثانية بعد قبول الأولى ولا ينشئ تعارضاً ذاتياً', async () => {
  const storage = new Map();
  const posts = [];
  let resolveFirstPersonRequest;
  let firstPersonRequest = true;
  const loadListeners = [];

  const localStorage = {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const window = {
    persons: [], khasmRows: [], injured: [], martyrs: [], hararin: [], tafaqudArchive: [], ghiyabArchive: [],
    personEvents: [], payrollRecords: [], payrollHeaders: [], operationalArchiveDocuments: [], nextId: 1, payrollNextId: 1,
    crypto: { randomUUID },
    saveState: () => undefined,
    addEventListener: (name, listener) => { if (name === 'load') loadListeners.push(listener); },
  };
  const document = {
    readyState: 'loading',
    addEventListener: () => {},
    getElementById: () => null,
    createElement: () => ({ style: {}, remove: () => {} }),
    body: { appendChild: () => {} },
  };
  const fetch = async (url, options) => {
    if (String(url).includes('/bootstrap')) return response({ operations: [], serverSequence: 0, hasMore: false });
    const body = JSON.parse(options.body);
    const operation = body.operations[0];
    posts.push(operation);
    if (operation.collection === 'persons' && operation.recordId === 'p-1' && firstPersonRequest) {
      firstPersonRequest = false;
      return new Promise((resolve) => { resolveFirstPersonRequest = resolve; });
    }
    return response({
      results: body.operations.map((item) => ({
        opId: item.opId,
        status: 'accepted',
        sequence: posts.length,
        record: {
          id: item.recordId,
          collection: item.collection,
          revision: item.baseRevision + 1,
          updatedAt: new Date().toISOString(),
          updatedBy: 'test',
          deletedAt: item.type === 'delete' ? new Date().toISOString() : null,
          payload: item.type === 'delete' ? null : item.payload,
        },
      })),
      serverSequence: posts.length,
    });
  };
  const context = {
    window, document, localStorage, fetch,
    crypto: window.crypto,
    setInterval: () => 0,
    setTimeout: (callback) => { callback(); return 0; },
    clearTimeout: () => {},
    console,
    Promise,
    JSON,
    Number,
    String,
    Array,
    Object,
  };
  window.window = window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sync-v2.js'), 'utf8'), context);
  loadListeners.forEach((listener) => listener());

  await waitFor(() => posts.length >= 1, 'لم تُرسل لقطة البداية');
  await waitFor(() => JSON.parse(localStorage.getItem('five66.sync.v2.queue') || '[]').length === 0, 'لم يفرغ طابور البداية');

  window.persons.push({ id: 'p-1', name: 'الإصدار الأول' });
  window.saveState();
  await waitFor(() => resolveFirstPersonRequest, 'لم تبدأ عملية الشخص الأولى');

  window.persons[0].name = 'الإصدار النهائي';
  window.saveState();
  resolveFirstPersonRequest(response({
    results: [{
      opId: posts.find((item) => item.collection === 'persons' && item.recordId === 'p-1').opId,
      status: 'accepted',
      sequence: 2,
      record: { id: 'p-1', collection: 'persons', revision: 1, updatedAt: new Date().toISOString(), updatedBy: 'test', deletedAt: null, payload: { id: 'p-1', name: 'الإصدار الأول' } },
    }],
    serverSequence: 2,
  }));

  await waitFor(() => posts.filter((item) => item.collection === 'persons' && item.recordId === 'p-1').length === 2, 'لم تُرسل العملية الثانية');
  const personOperations = posts.filter((item) => item.collection === 'persons' && item.recordId === 'p-1');
  assert.equal(personOperations[0].baseRevision, 0);
  assert.equal(personOperations[1].baseRevision, 1);
  assert.equal(personOperations[1].payload.name, 'الإصدار النهائي');
});
