// ===================== سيرفر الديوان العسكري =====================
// يوفر: تقديم الواجهة، تخزين دائم لبيانات النظام، ومزامنة لحظية بين المستخدمين

require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const { EventEmitter } = require('events');
const db = require('./db');
const syncDb = require('./sync-db');

// ----- بث فوري (SSE) -----
// ناقل أحداث داخلي بسيط داخل عملية Node نفسها: عند قبول أي عملية مزامنة، تُبث
// إشارة لكل قنوات /api/sync/stream المفتوحة حالياً، فتسحب كل الأجهزة الأخرى
// التحديث خلال أجزاء من الثانية بدل انتظار دورة الاستطلاع كل 5 ثوانٍ.
const syncBus = new EventEmitter();
syncBus.setMaxListeners(0);

const PORT = process.env.PORT || 3000;

// ----- مصادقة الخادم الموحدة -----
// كل بيانات مرور صحيحة تمنح الوصول نفسه. لا توجد أدوار admin أو viewer داخل التطبيق أو الخادم.
function getBasicAuthUsers() {
  if (process.env.BASIC_AUTH_USERS_JSON) {
    try {
      const users = JSON.parse(process.env.BASIC_AUTH_USERS_JSON);
      if (users && typeof users === 'object' && Object.keys(users).length) return users;
    } catch (_) {}
  }
  const users = {};
  // دعم أسماء المتغيرات القديمة أثناء الترحيل، من دون منح أي منهما دوراً مختلفاً.
  if (process.env.ADMIN_USER && process.env.ADMIN_PASS) users[process.env.ADMIN_USER] = process.env.ADMIN_PASS;
  if (process.env.VIEWER_USER && process.env.VIEWER_PASS) users[process.env.VIEWER_USER] = process.env.VIEWER_PASS;
  if (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASSWORD) users[process.env.BASIC_AUTH_USER] = process.env.BASIC_AUTH_PASSWORD;
  return users;
}

const basicAuthUsers = getBasicAuthUsers();
if (!Object.keys(basicAuthUsers).length) {
  console.error('❌ يجب ضبط BASIC_AUTH_USER/BASIC_AUTH_PASSWORD أو BASIC_AUTH_USERS_JSON قبل التشغيل.');
  process.exit(1);
}

// المفاتيح التي يخزّنها التطبيق (نفس مفاتيح localStorage السابقة)
const STATE_KEYS = [
  'mil_khasm',
  'mil_injured',
  'mil_martyrs',
  'mil_hararin',
  'mil_nextId',
  'mil_persons_added',
  'mil_persons_edited',
  'mil_persons_deleted',
  'mil_tafaqud_archive',
  'mil_ghiyab_archive',
  'mil_person_events',
  'mil_operational_archive',
  'mil_payroll',
  'mil_payroll_headers',
  'mil_payroll_nextId'
];

// ----- إعداد السيرفر -----
const app = express();
const server = http.createServer(app);

// Railway (وأي منصة استضافة تعمل خلف Reverse Proxy) تضيف ترويسة X-Forwarded-For
// لطلبات المستخدمين. express-rate-limit يرفض العمل بدون هذا الإعداد ويرمي خطأ
// "ValidationError" على كل طلب — وهذا كان يمنع تحميل الصفحة والـ API بالكامل.
app.set('trust proxy', 1);

// رؤوس أمان أساسية (helmet) — نعطّل CSP الافتراضي لأن الواجهة تحمّل سكربتات من عدة CDNs مضمّنة داخل index.html
app.use(helmet({ contentSecurityPolicy: false }));

// حماية شاملة من محاولات كسر كلمة المرور (Brute-force): حد أقصى للمحاولات على مستوى IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX || '200', 10), // قابل للضبط لتفادي حجب المستخدمين خلف شبكة مشتركة
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'محاولات كثيرة جداً، حاول لاحقاً' }
});
app.use(authLimiter);

// ----- حماية Basic Auth على كل شيء (الواجهة + كل الـ API) -----
app.use(basicAuth({
  users: basicAuthUsers,
  challenge: true,
  realm: 'Five66-IqZ9'
}));

// حد إضافي وأصرم لمحاولات كتابة/قراءة الـ API لمنع إغراق السيرفر بطلبات متكررة بعد اجتياز تسجيل الدخول
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number.parseInt(process.env.API_RATE_LIMIT_MAX || '600', 10),
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '50mb' }));

// تقديم الواجهة (index.html وملفات ثابتة، منها shamcash-photos.json و persons-photos.json إن وُجد)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/whoami', (req, res) => {
  res.json({ user: req.auth?.user || null });
});

// ----- واجهة برمجية: قراءة الحالة الكاملة (متاحة لكل من admin و viewer) -----
app.get('/api/state', async (req, res) => {
  const state = await db.readAll();
  res.json(state);
});

// المسار القديم للقراءة يبقى مؤقتاً لفتح البيانات السابقة، أما الكتابة فتتم فقط عبر عمليات الإصدار الدقيقة.
app.post('/api/state', (req, res) => {
  res.status(410).json({ ok: false, error: 'تم استبدال الحفظ الكامل بمزامنة دقيقة لكل سجل. حدّث الصفحة ثم حاول مجدداً.' });
});

app.get('/api/sync/bootstrap', async (req, res) => {
  try {
    const since = Number.parseInt(req.query.since || '0', 10);
    res.json(await syncDb.bootstrap(Number.isFinite(since) ? since : 0));
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    res.status(statusCode).json({ ok: false, error: statusCode === 503 ? 'التخزين الدائم غير متاح مؤقتاً؛ سيحتفظ التطبيق بالتعديلات محلياً ويعيد المحاولة.' : 'تعذر جلب تحديثات المزامنة' });
  }
});

app.post('/api/sync/operations', async (req, res) => {
  const opsCount = Array.isArray(req.body?.operations) ? req.body.operations.length : 0;
  const actor = req.auth?.user || 'server-user';
  console.log(`📥 POST /api/sync/operations — مستخدم: ${actor} — عدد العمليات: ${opsCount}`);
  try {
    const operations = Array.isArray(req.body?.operations) ? req.body.operations : [];
    if (!operations.length) return res.status(400).json({ ok: false, error: 'مطلوب إرسال عملية مزامنة واحدة على الأقل' });
    if (operations.length > 100) return res.status(413).json({ ok: false, error: 'الحد الأقصى لكل دفعة هو 100 عملية مزامنة' });
    const result = await syncDb.applyOperations(operations, actor);
    const acceptedCount = (result.results || []).filter((r) => r.status === 'accepted').length;
    const conflictCount = (result.results || []).filter((r) => r.status === 'conflict').length;
    console.log(`✅ POST /api/sync/operations نجح — مقبول: ${acceptedCount} — تعارض: ${conflictCount} — الخلفية: ${result.backend}`);
    // أبلغ كل من يفتح الصفحة الآن أن هناك تحديثاً جديداً، فتسحبه واجهته فوراً
    // عبر /api/sync/stream بدل الانتظار حتى دورة الاستطلاع الدورية التالية.
    if (acceptedCount > 0) {
      syncBus.emit('changed', { serverSequence: result.serverSequence, actor });
    }
    res.json({ results: result.results, serverSequence: result.serverSequence, backend: result.backend });
  } catch (error) {
    console.error('❌ POST /api/sync/operations error:', error);
    const statusCode = error?.statusCode || 500;
    res.status(statusCode).json({ ok: false, error: statusCode === 503 ? 'التخزين الدائم غير متاح مؤقتاً؛ لم تُفقد تعديلاتك وسيعيد التطبيق المحاولة.' : 'تعذر حفظ عمليات المزامنة' });
  }
});

// قناة بث لحظي (Server-Sent Events): محمية بنفس Basic Auth العام على التطبيق
// (وليست قناة مفتوحة بلا حماية كما كانت قناة Socket.io القديمة التي أُزيلت).
// كل عميل متصل يستقبل إشارة "sync" فور قبول أي تعديل من أي مستخدم آخر.
app.get('/api/sync/stream', (req, res) => {
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  const onChanged = (payload) => {
    try { res.write(`event: sync\ndata: ${JSON.stringify(payload)}\n\n`); } catch (_) {}
  };
  syncBus.on('changed', onChanged);
  // نبضة دورية لمنع أي بروكسي/منصة استضافة (مثل Railway) من قطع الاتصال الخامل.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    syncBus.off('changed', onChanged);
  });
});

// حالة الاتصال بـ Supabase (متاحة لكل من admin و viewer) — للتأكد قبل إعادة
// نشر/تشغيل السيرفر أن الاتصال سليم وأنه لا توجد بيانات محفوظة محلياً فقط
app.get('/api/sync-status', async (req, res) => {
  res.json({ legacy: db.getSyncStatus(), preciseSync: syncDb.status() });
});

// نسخة احتياطية يدوية: متاحة لكل من يملك بيانات مرور الخادم.
app.get('/api/backup', async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="diwan-backup.json"');
  res.json(await db.readAll());
});

// ===================== تحميل الملفات (حل مشكلة Android WebView) =====================
const _tempFiles = new Map();
const MAX_TEMP_FILES = 200; // حد أقصى لعدد الملفات المؤقتة المخزّنة في الذاكرة بنفس اللحظة

app.post('/api/download/upload', (req, res) => {
  try {
    const { data, mime, filename } = req.body || {};
    if (!data || !mime || !filename) {
      return res.status(400).json({ ok: false, error: 'بيانات ناقصة' });
    }
    // تنظيف الملفات المنتهية أولاً
    for (const [k, v] of _tempFiles.entries()) {
      if (v.expiresAt < Date.now()) _tempFiles.delete(k);
    }
    // منع إغراق الذاكرة: إذا امتلأت السعة، احذف الأقدم
    if (_tempFiles.size >= MAX_TEMP_FILES) {
      const oldestKey = _tempFiles.keys().next().value;
      _tempFiles.delete(oldestKey);
    }
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const expiresAt = Date.now() + 5 * 60 * 1000;
    _tempFiles.set(token, { data, mime, filename, expiresAt });
    res.json({ ok: true, url: '/api/download/' + token });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/download/:token', (req, res) => {
  const entry = _tempFiles.get(req.params.token);
  if (!entry || entry.expiresAt < Date.now()) {
    _tempFiles.delete(req.params.token);
    return res.status(404).send('انتهت صلاحية الرابط');
  }
  const buf = Buffer.from(entry.data, 'base64');
  res.setHeader('Content-Type', entry.mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(entry.filename)}`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
  _tempFiles.delete(req.params.token);
});

// ----- ترحيل بيانات لمرة واحدة (اختياري) — راجع migrate-persons-fix.js -----
async function startServer() {
  if (process.env.RUN_PERSON_FIX_2026_08 === 'true') {
    await require('./migrate-persons-fix').run(db);
  }
  server.listen(PORT, () => {
    console.log(`✅ سيرفر الديوان العسكري يعمل على المنفذ ${PORT}`);
    console.log(`   افتح: http://<server-ip>:${PORT}`);
  });
}
startServer();
