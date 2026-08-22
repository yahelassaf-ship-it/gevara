// ===================== Service Worker — الديوان العسكري =====================
// الهدف: تخزين "هيكل" التطبيق (الصفحة الرئيسية بكل أصولها المضمّنة)
// محلياً عبر Cache Storage API (لا حدود حجم منخفضة كـ localStorage)
// بحيث يفتح التطبيق فوراً حتى بدون إنترنت.
// بيانات API ومزامنة Socket.io تبقى دائماً Network-only لأن منطق
// المزامنة (pending state) موجود بالفعل داخل index.html.
//
// ⚠️ ملاحظة مهمة: كل مرة يتغيّر فيها index.html، يجب رفع رقم CACHE_NAME هنا
// (حتى لو حرفاً واحداً) — المتصفح لا يكتشف تحديثاً لملف الـ Service Worker
// نفسه إلا إذا تغيّرت محتوياته بايتاً بايت. بدون رفع الرقم هنا، أي نشر جديد
// لصفحة التطبيق يبقى غير مرئي للمستخدمين رغم نجاح النشر على السيرفر.

const CACHE_NAME = 'diwan-shell-v5';
const SHELL_URLS = ['/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch((err) => console.warn('SW install cache error:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// يسمح لصفحة التطبيق بطلب تفعيل نسخة الـ Service Worker الجديدة فوراً
// (بدل انتظار إغلاق كل التبويبات المفتوحة) — راجع الاستماع لـ 'controllerchange'
// داخل index.html الذي يعيد تحميل الصفحة تلقائياً بعد التفعيل.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  // فقط نفس الأصل (origin) نتعامل معه
  if (url.origin !== self.location.origin) {
    return;
  }

  // طلبات API والمزامنة اللحظية (Socket.io): تذهب دائماً للشبكة مباشرة
  // ولا تُخزَّن أبداً، حتى لا تتعارض مع منطق المزامنة الموجود في الصفحة.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(
          JSON.stringify({ offline: true, message: 'لا يوجد اتصال بالإنترنت حالياً' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // لا نتدخل في أي طلب غير GET (مثل POST لحفظ البيانات)
  if (req.method !== 'GET') {
    return;
  }

  // صفحة التطبيق نفسها (هيكل HTML): Network-First. أهم تغيير — كنا نعرض
  // النسخة المخزّنة محلياً فوراً دائماً حتى لو كان هناك اتصال إنترنت سليم
  // (Stale-While-Revalidate)، مما كان يُخفي أي كود جديد بعد النشر عن
  // المستخدم لحد ما يعيد فتح التبويب مرتين أو يمسح الكاش يدوياً. الآن:
  // نحاول الشبكة أولاً دوماً، ولا نستخدم النسخة المخزّنة إلا عند انقطاع
  // فعلي للاتصال — هذا يحافظ على ميزة العمل بدون نت دون إخفاء التحديثات.
  if (req.mode === 'navigate' || SHELL_URLS.includes(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
    );
    return;
  }

  // باقي الأصول الثابتة (غير صفحة التطبيق نفسها): Stale-While-Revalidate
  // يبقى مناسباً هنا (سريع، وتُحدَّث بالخلفية دون التأثير على منطق الحفظ).
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
