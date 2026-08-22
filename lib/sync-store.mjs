import { randomUUID } from "node:crypto";

const MAX_OPERATIONS = 5000;
const MAX_DEDUPLICATION_RESULTS = 10000;

export function createEmptySyncDatabase() {
  return {
    schemaVersion: 2,
    sequence: 0,
    collections: {},
    operations: [],
    operationResults: {},
  };
}

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOperation(operation) {
  if (!isPlainObject(operation)) return { error: "عملية مزامنة غير صالحة" };
  const opId = typeof operation.opId === "string" ? operation.opId.slice(0, 128) : "";
  const collection = typeof operation.collection === "string" ? operation.collection.slice(0, 80) : "";
  const recordId = typeof operation.recordId === "string" ? operation.recordId.slice(0, 160) : "";
  const type = operation.type;
  const baseRevision = Number.isInteger(operation.baseRevision) && operation.baseRevision >= 0 ? operation.baseRevision : null;

  if (!opId || !collection || !recordId || !["upsert", "delete"].includes(type) || baseRevision === null) {
    return { error: "بيانات عملية المزامنة ناقصة أو غير صالحة" };
  }
  if (type === "upsert" && !isPlainObject(operation.payload)) {
    return { error: "بيانات السجل غير صالحة" };
  }
  if (type === "upsert" && Buffer.byteLength(JSON.stringify(operation.payload), "utf8") > 512_000) {
    return { error: "حجم السجل أكبر من الحد المسموح" };
  }
  return { opId, collection, recordId, type, baseRevision, payload: copy(operation.payload), force: operation.force === true };
}

function makeConflict(operation, current) {
  return {
    opId: operation.opId,
    status: "conflict",
    record: current ? copy(current) : null,
    message: "تم تعديل هذا السجل من جهاز آخر قبل حفظ تعديلاتك.",
  };
}

function trimDatabase(database) {
  if (database.operations.length > MAX_OPERATIONS) {
    database.operations.splice(0, database.operations.length - MAX_OPERATIONS);
  }
  const keys = Object.keys(database.operationResults);
  if (keys.length > MAX_DEDUPLICATION_RESULTS) {
    keys.slice(0, keys.length - MAX_DEDUPLICATION_RESULTS).forEach((key) => delete database.operationResults[key]);
  }
}

export function applyOperations(database, operations, actor) {
  const accepted = [];
  const results = [];

  for (const input of operations) {
    const operation = normalizeOperation(input);
    if (operation.error) {
      results.push({ opId: input?.opId ?? null, status: "invalid", message: operation.error });
      continue;
    }

    const previousResult = database.operationResults[operation.opId];
    if (previousResult) {
      results.push(copy(previousResult));
      continue;
    }

    const collection = (database.collections[operation.collection] ??= {});
    const current = collection[operation.recordId] ?? null;
    const currentRevision = current?.revision ?? 0;

    if (operation.baseRevision !== currentRevision && !operation.force) {
      const conflict = makeConflict(operation, current);
      database.operationResults[operation.opId] = conflict;
      results.push(copy(conflict));
      continue;
    }

    const now = new Date().toISOString();
    const record = {
      id: operation.recordId,
      collection: operation.collection,
      revision: currentRevision + 1,
      updatedAt: now,
      updatedBy: actor,
      deletedAt: operation.type === "delete" ? now : null,
      payload: operation.type === "delete" ? null : operation.payload,
    };
    collection[operation.recordId] = record;
    database.sequence += 1;

    const acceptedOperation = {
      sequence: database.sequence,
      opId: operation.opId,
      clientId: input.clientId ?? null,
      type: operation.type,
      record: copy(record),
      actor,
      acceptedAt: now,
    };
    database.operations.push(acceptedOperation);
    const result = { opId: operation.opId, status: "accepted", record: copy(record), sequence: database.sequence };
    database.operationResults[operation.opId] = result;
    accepted.push(acceptedOperation);
    results.push(copy(result));
  }

  trimDatabase(database);
  return { results, accepted, sequence: database.sequence };
}

export function getBootstrap(database, since = 0, limit = 500) {
  const normalizedSince = Number.isInteger(since) && since >= 0 ? since : 0;
  const operations = database.operations.filter((operation) => operation.sequence > normalizedSince).slice(0, limit);
  return {
    schemaVersion: database.schemaVersion,
    serverSequence: database.sequence,
    hasMore: operations.length === limit && operations.at(-1)?.sequence < database.sequence,
    operations: copy(operations),
  };
}

export function createOperationId() {
  return randomUUID();
}
