(function () {
  "use strict";

  var BASE = "/api/sync";
  var QUEUE_KEY = "five66.sync.v2.queue";
  var CURSOR_KEY = "five66.sync.v2.cursor";
  var CONFLICT_KEY = "five66.sync.v2.conflicts";
  var REVISIONS_KEY = "five66.sync.v2.revisions";
  var clientId = "five66_" + Math.random().toString(36).slice(2) + Date.now();
  var cursor = Number(localStorage.getItem(CURSOR_KEY) || "0");
  // إصلاح حاسم: أرقام نسخ السجلات كانت تُحفظ في الذاكرة فقط. بعد إعادة فتح الصفحة
  // لا يعيد bootstrap إلا العمليات الأحدث من علامة الجهاز، فتبقى نسخ السجلات
  // القديمة مجهولة ويُرسل أي تعديل عليها بـ baseRevision=0 فيرفضه الخادم كتعارض
  // وهمي — ويبدو التعديل محفوظاً محلياً لكنه لا يصل إلى Supabase أبداً.
  // الآن نخزّن النسخ في localStorage لتبقى صحيحة بين الجلسات.
  var knownRevisions = (function () {
    try {
      var saved = JSON.parse(localStorage.getItem(REVISIONS_KEY) || "{}");
      return (saved && typeof saved === "object") ? saved : {};
    } catch (_) { return {}; }
  })();
  function saveKnownRevisions() {
    try {
      var keys = Object.keys(knownRevisions);
      if (keys.length > 20000) {
        var trimmed = {};
        keys.slice(-10000).forEach(function (k) { trimmed[k] = knownRevisions[k]; });
        knownRevisions = trimmed;
      }
      localStorage.setItem(REVISIONS_KEY, JSON.stringify(knownRevisions));
    } catch (_) {}
  }
  var snapshots = {};
  var applyingRemote = false;
  var enabled = false;
  var startRetryTimer = null;
  var flushPromise = null;
  var pullPromise = null;
  var inFlightIds = {};

  var sources = [
    ["persons", "persons"], ["khasm", "khasmRows"], ["injured", "injured"], ["martyrs", "martyrs"],
    ["hararin", "hararin"], ["tafaqud", "tafaqudArchive"], ["ghiyab", "ghiyabArchive"],
    ["events", "personEvents"], ["payroll", "payrollRecords"], ["payrollHeaders", "payrollHeaders"],
    ["operational_archive", "operationalArchiveDocuments"]
  ];

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function notify(message, type) {
    if (typeof window.showToast === "function") window.showToast(message, type || "info");
  }
  function getQueue() {
    try {
      var queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
      return Array.isArray(queue) ? queue : [];
    } catch (_) { return []; }
  }
  function setQueue(queue) { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); }
  function opId() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (clientId + "_" + Date.now() + "_" + Math.random().toString(36).slice(2)); }
  function collectionItems(variable) { return Array.isArray(window[variable]) ? window[variable] : []; }
  function revisionKey(collection, recordId) { return collection + ":" + recordId; }
  function recordId(item, collection, index) {
    if (item && item.id !== undefined && item.id !== null) return String(item.id);
    if (item && item._id !== undefined && item._id !== null) return String(item._id);
    if (!item._syncId) item._syncId = collection + "_" + Date.now() + "_" + index + "_" + Math.random().toString(36).slice(2, 8);
    return String(item._syncId);
  }
  function takeSnapshot() {
    var next = {};
    sources.forEach(function (source) {
      var collection = source[0], variable = source[1];
      next[collection] = {};
      collectionItems(variable).forEach(function (item, index) {
        if (!item || typeof item !== "object") return;
        var id = recordId(item, collection, index);
        next[collection][id] = clone(item);
      });
    });
    next.meta = { counters: { nextId: window.nextId || 1, payrollNextId: window.payrollNextId || 1 } };
    return next;
  }

  // ندمج التغييرات غير المرسلة على السجل نفسه في عملية واحدة. وهذا يمنع التعارض
  // الذاتي عند تعديل الحقل أكثر من مرة قبل أن تصل أول دفعة إلى الخادم.
  function enqueue(operation) {
    var queue = getQueue();
    var index = -1;
    for (var i = queue.length - 1; i >= 0; i--) {
      var candidate = queue[i];
      if (candidate.collection === operation.collection && candidate.recordId === operation.recordId && !inFlightIds[candidate.opId]) {
        index = i;
        break;
      }
    }
    if (index >= 0) {
      var previous = queue[index];
      operation.opId = previous.opId;
      operation.baseRevision = previous.baseRevision;
      queue[index] = operation;
    } else {
      queue.push(operation);
    }
    setQueue(queue);
  }
  function queueInitialSnapshot() {
    var initial = takeSnapshot();
    Object.keys(initial).forEach(function (collection) {
      Object.keys(initial[collection] || {}).forEach(function (id) {
        enqueue({ opId: opId(), collection: collection, recordId: id, type: "upsert", baseRevision: 0, payload: initial[collection][id] });
      });
    });
    snapshots = initial;
  }
  function queueDifferences() {
    if (!enabled || applyingRemote) return;
    var next = takeSnapshot();
    Object.keys(next).forEach(function (collection) {
      var before = snapshots[collection] || {}, after = next[collection] || {};
      Object.keys(after).forEach(function (id) {
        if (JSON.stringify(before[id]) !== JSON.stringify(after[id])) {
          enqueue({ opId: opId(), collection: collection, recordId: id, type: "upsert", baseRevision: knownRevisions[revisionKey(collection, id)] || 0, payload: after[id] });
        }
      });
      Object.keys(before).forEach(function (id) {
        if (!Object.prototype.hasOwnProperty.call(after, id)) {
          enqueue({ opId: opId(), collection: collection, recordId: id, type: "delete", baseRevision: knownRevisions[revisionKey(collection, id)] || 0 });
        }
      });
    });
    snapshots = next;
  }
  function setRecord(record) {
    if (!record || !record.collection || record.id === undefined || record.id === null) return;
    if (record.collection === "meta" && record.id === "counters") {
      if (record.payload) {
        window.nextId = record.payload.nextId || window.nextId;
        window.payrollNextId = record.payload.payrollNextId || window.payrollNextId;
      }
      knownRevisions[revisionKey(record.collection, record.id)] = record.revision;
      saveKnownRevisions();
      return;
    }
    var source = sources.find(function (item) { return item[0] === record.collection; });
    if (!source) return;
    var collection = collectionItems(source[1]);
    var index = collection.findIndex(function (item, itemIndex) { return recordId(item, record.collection, itemIndex) === String(record.id); });
    if (record.deletedAt) {
      if (index >= 0) collection.splice(index, 1);
    } else if (index >= 0) {
      collection[index] = clone(record.payload);
    } else {
      collection.push(clone(record.payload));
    }
    knownRevisions[revisionKey(record.collection, record.id)] = record.revision;
    saveKnownRevisions();
  }
  function refreshViews() {
    [
      "renderCards", "renderTable", "renderPagination", "buildTafaqudFilters", "buildTafaqudTable",
      "buildGhiyabFilters", "buildGhiyabTable", "renderInjured", "renderMartyrs", "renderHararin",
      "renderKhasmTable", "populateKhasmDropdown", "populateTafaqudDropdown", "populatePayrollFilters",
      "buildPayrollTable", "renderIstihqaqTable", "updateStats", "updateSectionHeaders", "refreshNotifications"
    ].forEach(function (name) {
      try { if (typeof window[name] === "function") window[name](); } catch (_) {}
    });
    try { if (window.Five66Archive && typeof window.Five66Archive.render === "function") window.Five66Archive.render(); } catch (_) {}
  }
  function applyOperations(operations) {
    if (!operations || !operations.length) return;
    applyingRemote = true;
    try {
      operations.forEach(function (operation) { if (operation.record) setRecord(operation.record); });
      snapshots = takeSnapshot();
    } finally {
      applyingRemote = false;
    }
    refreshViews();
  }

  async function pullAll() {
    var lastData = { operations: [], serverSequence: cursor, hasMore: false };
    do {
      var previousCursor = cursor;
      var response = await fetch(BASE + "/bootstrap?since=" + encodeURIComponent(cursor), { cache: "no-store" });
      if (!response.ok) throw new Error("تعذر جلب تحديثات الخادم");
      var data = await response.json();
      applyOperations(data.operations || []);
      var nextCursor = Number(data.serverSequence);
      if (Number.isFinite(nextCursor) && nextCursor >= cursor) cursor = nextCursor;
      localStorage.setItem(CURSOR_KEY, String(cursor));
      lastData = data;
      if (data.hasMore && cursor <= previousCursor) throw new Error("تعذر متابعة صفحة المزامنة التالية");
    } while (lastData.hasMore);
    return lastData;
  }
  function pull() {
    if (pullPromise) return pullPromise;
    pullPromise = pullAll().finally(function () { pullPromise = null; });
    return pullPromise;
  }

  function renderConflictBar() {
    var count = getConflicts().length;
    var bar = document.getElementById("sync-v2-conflict-bar");
    if (!count) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement("button");
      bar.id = "sync-v2-conflict-bar";
      bar.type = "button";
      bar.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:999999;background:#8b1a1a;color:#fff8dc;border:1px solid #e9c76a;border-radius:14px;padding:12px 16px;font:700 13px Cairo,Tajawal,sans-serif;direction:rtl;box-shadow:0 5px 18px rgba(0,0,0,.35);cursor:pointer";
      bar.onclick = function () {
        var conflict = getConflicts()[0];
        if (!conflict) return;
        var keepLocal = window.confirm("حدث تعارض في سجل واحد. اضغط «موافق» للاحتفاظ بتعديلك ورفعه كنسخة أحدث، أو «إلغاء» لاعتماد تعديل الخادم.");
        resolveConflict(conflict.opId, keepLocal ? "local" : "server");
      };
      document.body.appendChild(bar);
    }
    bar.textContent = "⚠ توجد " + count + " تعارضات مزامنة — اضغط لاختيار النسخة المطلوبة";
  }
  function showConflict() {
    renderConflictBar();
    notify("⚠ توجد " + getConflicts().length + " تعارضات مزامنة. لم تُكتب تعديلاتك فوق بيانات مستخدم آخر.", "error");
  }
  function getConflicts() { try { return JSON.parse(localStorage.getItem(CONFLICT_KEY) || "[]"); } catch (_) { return []; } }
  function saveConflicts(conflicts) { localStorage.setItem(CONFLICT_KEY, JSON.stringify(conflicts)); }
  function resolveConflict(conflictOpId, choice) {
    var conflicts = getConflicts();
    var conflict = conflicts.find(function (item) { return item.opId === conflictOpId; });
    if (!conflict) return;
    if (choice === "local" && conflict.localOperation && conflict.record) {
      enqueue({
        opId: opId(),
        collection: conflict.localOperation.collection,
        recordId: conflict.localOperation.recordId,
        type: conflict.localOperation.type,
        baseRevision: conflict.record.revision,
        payload: conflict.localOperation.payload
      });
    } else if (choice === "server" && conflict.record) {
      applyOperations([{ record: conflict.record }]);
    }
    saveConflicts(conflicts.filter(function (item) { return item.opId !== conflictOpId; }));
    renderConflictBar();
    flush().catch(function () {});
  }

  function updateQueuedRevisions(queue, acceptedRecords) {
    return queue.map(function (operation) {
      var record = acceptedRecords[revisionKey(operation.collection, operation.recordId)];
      if (record && !inFlightIds[operation.opId]) {
        operation.baseRevision = record.revision;
      }
      return operation;
    });
  }
  async function flushQueue() {
    while (true) {
      var queue = getQueue();
      if (!queue.length) return;
      var batch = queue.slice(0, 100);
      batch.forEach(function (operation) { inFlightIds[operation.opId] = true; });
      var response;
      try {
        response = await fetch(BASE + "/operations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: clientId, operations: batch })
        });
        if (!response.ok) throw new Error("تعذر رفع التعديلات إلى الخادم");
        var data = await response.json();
        var completedIds = {}, conflictItems = getConflicts(), acceptedRecords = {};
        (data.results || []).forEach(function (result) {
          if (result.status === "accepted") {
            completedIds[result.opId] = true;
            if (result.record) {
              knownRevisions[revisionKey(result.record.collection, result.record.id)] = result.record.revision;
              acceptedRecords[revisionKey(result.record.collection, result.record.id)] = result.record;
              saveKnownRevisions();
            }
          } else if (result.status === "conflict") {
            completedIds[result.opId] = true;
            conflictItems.push({ opId: result.opId, record: result.record, message: result.message, localOperation: batch.find(function (operation) { return operation.opId === result.opId; }) || null });
          }
        });
        batch.forEach(function (operation) { delete inFlightIds[operation.opId]; });
        // اقرأ أحدث نسخة من الطابور: قد يكون المستخدم عدّل سجلاً أثناء انتظار الرد.
        var remaining = getQueue().filter(function (operation) { return !completedIds[operation.opId]; });
        setQueue(updateQueuedRevisions(remaining, acceptedRecords));
        saveConflicts(conflictItems.slice(-100));
        var serverSequence = Number(data.serverSequence);
        if (Number.isFinite(serverSequence)) cursor = Math.max(cursor, serverSequence);
        localStorage.setItem(CURSOR_KEY, String(cursor));
        snapshots = takeSnapshot();
        if (conflictItems.length) showConflict();
      } catch (error) {
        batch.forEach(function (operation) { delete inFlightIds[operation.opId]; });
        throw error;
      }
    }
  }
  function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = flushQueue().finally(function () { flushPromise = null; });
    return flushPromise;
  }

  async function start() {
    try {
      if (startRetryTimer) { clearTimeout(startRetryTimer); startRetryTimer = null; }
      var initialBootstrap = await pull();
      enabled = true;
      if (!Number(initialBootstrap.serverSequence || 0)) queueInitialSnapshot();
      else snapshots = takeSnapshot();
      var originalSave = window.saveState;
      window.saveState = function () {
        var result = typeof originalSave === "function" ? originalSave.apply(this, arguments) : undefined;
        setTimeout(function () { queueDifferences(); flush().catch(function () {}); }, 0);
        return result;
      };
      // التقط أي تعديلات حدثت قبل اكتمال بدء المزامنة (مثلاً دمج السجلات أثناء
      // initApp) — كانت تدخل اللقطة من دون أن تُرفع فتضيع من الأجهزة الأخرى.
      queueDifferences();
      if (getQueue().length) await flush();
      window.addEventListener("online", function () { queueDifferences(); pull().then(flush).catch(function () {}); });
      document.addEventListener("visibilitychange", function () { if (!document.hidden) { queueDifferences(); pull().then(flush).catch(function () {}); } });
      // شبكة أمان دورية: أي تعديل على البيانات مرّ دون saveState يُكتشف ويُزامَن.
      setInterval(function () { queueDifferences(); pull().then(flush).catch(function () {}); }, 5000);
      notify("✓ المزامنة الدقيقة مفعّلة", "success");
    } catch (_) {
      notify("⚠ التخزين الدائم غير متاح مؤقتاً؛ سيستمر الحفظ المحلي وستُعاد المحاولة تلقائياً.", "error");
      if (!startRetryTimer) startRetryTimer = setTimeout(function () { startRetryTimer = null; start(); }, 5000);
    }
  }

  window.Five66Sync = { pull: pull, flush: flush, getConflicts: getConflicts, resolveConflict: resolveConflict };
  if (document.readyState === "complete") setTimeout(start, 500);
  else window.addEventListener("load", function () { setTimeout(start, 500); });
})();
