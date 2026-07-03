/* ===================================================================
   service-worker.js — تخزين مؤقت بسيط للعمل دون اتصال
   - قشرة التطبيق: cache-first مع تحديث بالخلفية
   - مكتبات CDN: تُخزَّن عند أول استخدام (بما فيها ملفات OCR الثقيلة)
=================================================================== */
"use strict";

const CACHE = "chapter-splitter-v1";

const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg",
];

// النطاقات المسموح تخزين مواردها وقت التشغيل (pdf.js, pdf-lib, tesseract, jszip)
const CDN_HOSTS = [
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "tessdata.projectnaptha.com",
  "unpkg.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isShell = url.origin === self.location.origin;
  const isCDN = CDN_HOSTS.includes(url.hostname);
  if (!isShell && !isCDN) return;

  // cache-first: مثالي للأجهزة الضعيفة وشبكات بطيئة
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // نخزّن الاستجابات الصالحة فقط
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // دون اتصال وبدون نسخة مخزّنة — نعيد الصفحة الرئيسية للتنقلات
          if (req.mode === "navigate") return caches.match("./index.html");
        });
    })
  );
});
