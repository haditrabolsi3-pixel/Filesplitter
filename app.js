/* ===================================================================
   فاصل الفصول — app.js
   المبادئ: معالجة كسولة، دفعات صغيرة، لا حجب للخيط الرئيسي،
   OCR عند الطلب فقط، تحرير الذاكرة بعد كل صفحة.
=================================================================== */
"use strict";

/* ---------- الحالة العامة ---------- */
const state = {
  pdfDoc: null,          // مستند pdf.js (للعرض واستخراج النص)
  originalBytes: null,   // نسخة البايتات الأصلية (لـ pdf-lib عند التقسيم)
  fileName: "",
  numPages: 0,
  chapterStarts: new Set(),   // أرقام صفحات بداية الفصول (1-based)
  manualStarts: new Set(),
  chapterTitles: {},          // page -> عنوان مكتشف
  smartMode: false,
  deepScan: false,
  busy: false,
  cancelled: false,
  blobs: [],                  // نتائج التقسيم { name, url, size, pages }
  ocrWorker: null,
};

const BATCH_SIZE = 3;          // صفحات لكل دفعة تحليل
const EAGER_THUMBS = 10;       // معاينات تُرسم فوراً
const THUMB_WIDTH = 130;       // عرض المعاينة بالبكسل
const OCR_MAX_WIDTH = 1000;    // أقصى عرض لصورة OCR
const OCR_MAX_SCALE = 0.7;

/* ---------- عناصر الواجهة ---------- */
const $ = (id) => document.getElementById(id);
const els = {
  dropZone: $("dropZone"), fileInput: $("fileInput"),
  fileInfo: $("fileInfo"), fileName: $("fileName"), filePages: $("filePages"),
  resetBtn: $("resetBtn"),
  modes: $("modes"), fastModeBtn: $("fastModeBtn"), smartModeBtn: $("smartModeBtn"),
  deepScanRow: $("deepScanRow"), deepScanToggle: $("deepScanToggle"),
  detectBtn: $("detectBtn"),
  progressCard: $("progressCard"), progressLabel: $("progressLabel"),
  progressCount: $("progressCount"), progressBar: $("progressBar"),
  cancelBtn: $("cancelBtn"),
  previewSection: $("previewSection"), thumbGrid: $("thumbGrid"),
  chapterCount: $("chapterCount"),
  splitSection: $("splitSection"), splitBtn: $("splitBtn"),
  resultsList: $("resultsList"), zipBtn: $("zipBtn"),
};

/* ---------- أدوات مساعدة ---------- */
// إعادة السيطرة للخيط الرئيسي بين الدفعات
const yieldToUI = () =>
  new Promise((resolve) => {
    if ("requestIdleCallback" in window) requestIdleCallback(resolve, { timeout: 120 });
    else setTimeout(resolve, 0);
  });

// تحرير ذاكرة الكانفس فوراً
function freeCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

function setProgress(label, done, total) {
  els.progressCard.classList.remove("hidden");
  els.progressLabel.textContent = label;
  els.progressCount.textContent = total ? `${done} / ${total}` : "";
  els.progressBar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
}
function hideProgress() { els.progressCard.classList.add("hidden"); }

// تحميل سكربت خارجي عند الحاجة فقط (Tesseract / JSZip)
function loadScriptOnce(src) {
  if (loadScriptOnce.cache?.[src]) return loadScriptOnce.cache[src];
  loadScriptOnce.cache = loadScriptOnce.cache || {};
  loadScriptOnce.cache[src] = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("تعذّر تحميل: " + src));
    document.head.appendChild(s);
  });
  return loadScriptOnce.cache[src];
}

/* ---------- أنماط اكتشاف الفصول ---------- */
const ARABIC_ORDINALS =
  "الأول|الثاني|الثالث|الرابع|الخامس|السادس|السابع|الثامن|التاسع|العاشر|" +
  "الحادي عشر|الثاني عشر|الثالث عشر|الرابع عشر|الخامس عشر|الأخير";

const CHAPTER_PATTERNS = [
  /\b(chapter|section|part)\s+(\d+|[ivxlcdm]+)\b/i,
  /\bCHAPTER\s+\w+/,
  new RegExp(`(الفصل|الباب|القسم|المبحث|الجزء)\\s+(${ARABIC_ORDINALS}|[\\d١-٩]+)`),
  /(الفصل|الباب)\s*[:：]/,
];

// يفحص أول جزء من نص الصفحة (عناوين الفصول تكون في الأعلى غالباً)
function findChapterTitle(pageText) {
  const head = pageText.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!head) return null;
  for (const re of CHAPTER_PATTERNS) {
    const m = head.match(re);
    if (m) {
      const idx = head.indexOf(m[0]);
      return head.slice(idx, idx + 60).trim();
    }
  }
  return null;
}

/* ---------- رفع الملف ---------- */
els.dropZone.addEventListener("click", () => els.fileInput.click());
els.dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
});
["dragover", "dragenter"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("dragover");
  })
);
els.dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});
els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleFile(file);
});

async function handleFile(file) {
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    alert("الرجاء اختيار ملف PDF.");
    return;
  }
  await resetAll(false);
  state.fileName = file.name.replace(/\.pdf$/i, "");

  setProgress("جارٍ فتح الملف…", 0, 0);
  try {
    const buf = await file.arrayBuffer();
    els.fileInput.value = ""; // للسماح باختيار الملف نفسه مجدداً
    // نسخة محفوظة لـ pdf-lib — لأن pdf.js ينقل الـ buffer إلى الـ worker ويُفرغه
    state.originalBytes = new Uint8Array(buf).slice();

    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    state.pdfDoc = await pdfjsLib.getDocument({
      data: buf,
      disableAutoFetch: true,   // لا تجلب كل شيء مسبقاً
      disableStream: false,
    }).promise;

    state.numPages = state.pdfDoc.numPages;

    els.fileName.textContent = file.name;
    els.filePages.textContent = `${state.numPages} صفحة`;
    els.fileInfo.classList.remove("hidden");
    els.modes.classList.remove("hidden");
    els.previewSection.classList.remove("hidden");
    els.splitSection.classList.remove("hidden");
    hideProgress();

    buildThumbGrid();
    updateChapterUI();
  } catch (err) {
    hideProgress();
    alert("تعذّر فتح الملف: " + err.message);
    await resetAll(false);
  }
}

/* ---------- المعاينات (كسولة) ---------- */
let thumbObserver = null;
const renderQueue = [];
let renderingThumb = false;

function buildThumbGrid() {
  els.thumbGrid.innerHTML = "";
  thumbObserver?.disconnect();

  // مراقب ظهور للمعاينات المتبقية بعد أول 10
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        thumbObserver.unobserve(entry.target);
        enqueueThumb(Number(entry.target.dataset.page));
      }
    }
  }, { rootMargin: "200px" });

  const frag = document.createDocumentFragment();
  for (let p = 1; p <= state.numPages; p++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "thumb pending";
    btn.dataset.page = p;
    btn.setAttribute("aria-label", `الصفحة ${p} — اضغط لتحديد بداية فصل`);
    const num = document.createElement("span");
    num.className = "pnum";
    num.textContent = p;
    btn.appendChild(num);
    btn.addEventListener("click", () => toggleManualChapter(p));
    frag.appendChild(btn);
    if (p > EAGER_THUMBS) thumbObserver.observe(btn);
  }
  els.thumbGrid.appendChild(frag);

  // أول 10 صفحات فقط تُرسم فوراً
  for (let p = 1; p <= Math.min(EAGER_THUMBS, state.numPages); p++) enqueueThumb(p);
}

function enqueueThumb(pageNum) {
  renderQueue.push(pageNum);
  drainThumbQueue();
}

// رسم معاينة واحدة في كل مرة — لا نُشغل الجهاز الضعيف بأكثر من كانفس
async function drainThumbQueue() {
  if (renderingThumb) return;
  renderingThumb = true;
  while (renderQueue.length) {
    const pageNum = renderQueue.shift();
    const el = els.thumbGrid.querySelector(`[data-page="${pageNum}"]`);
    if (!el || !state.pdfDoc || el.querySelector("img")) continue;
    try {
      const page = await state.pdfDoc.getPage(pageNum);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      await page.render({ canvasContext: ctx, viewport }).promise;

      // نحوّل الكانفس إلى JPEG صغير ثم نحرره فوراً — أخف بكثير من إبقاء كانفس لكل صفحة
      const img = document.createElement("img");
      img.src = canvas.toDataURL("image/jpeg", 0.65);
      img.alt = "";
      img.decoding = "async";
      el.prepend(img);
      el.classList.remove("pending");

      freeCanvas(canvas);
      page.cleanup();
    } catch { /* صفحة تالفة — نتجاهلها */ }
    await yieldToUI();
  }
  renderingThumb = false;
}

/* ---------- الأوضاع ---------- */
els.fastModeBtn.addEventListener("click", () => setMode(false));
els.smartModeBtn.addEventListener("click", () => setMode(true));
function setMode(smart) {
  state.smartMode = smart;
  els.fastModeBtn.classList.toggle("active", !smart);
  els.smartModeBtn.classList.toggle("active", smart);
  els.fastModeBtn.setAttribute("aria-checked", String(!smart));
  els.smartModeBtn.setAttribute("aria-checked", String(smart));
  els.deepScanRow.classList.toggle("hidden", !smart);
  if (!smart) { state.deepScan = false; els.deepScanToggle.checked = false; }
}
els.deepScanToggle.addEventListener("change", (e) => {
  state.deepScan = e.target.checked;
});

/* ---------- اكتشاف الفصول (دفعات + إفساح للواجهة) ---------- */
els.detectBtn.addEventListener("click", detectChapters);
els.cancelBtn.addEventListener("click", () => { state.cancelled = true; });

async function detectChapters() {
  if (!state.pdfDoc || state.busy) return;
  state.busy = true;
  state.cancelled = false;
  els.detectBtn.disabled = true;
  state.chapterStarts = new Set(state.manualStarts);
  state.chapterTitles = {};

  const total = state.numPages;
  let ocrCandidates = [];

  // المرحلة 1: استخراج النص المباشر (سريع)
  for (let start = 1; start <= total && !state.cancelled; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, total);
    for (let p = start; p <= end; p++) {
      setProgress("تحليل النص…", p, total);
      try {
        const page = await state.pdfDoc.getPage(p);
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items) text += item.str + " ";
        page.cleanup();

        const textless = text.trim().length < 10;
        let found = false;
        if (!textless) {
          const title = findChapterTitle(text);
          if (title) {
            state.chapterStarts.add(p);
            state.chapterTitles[p] = title;
            found = true;
          }
        }
        // OCR كخطة بديلة: في الوضع الذكي للصفحات بلا نص،
        // أو لكل الصفحات إن فُعِّل الفحص العميق (نص مستخرج مشوّه/ترميز خاص)
        if (state.smartMode && !found && (textless || state.deepScan)) {
          ocrCandidates.push(p);
        }
        text = null;
      } catch { /* تجاهل الصفحة */ }
    }
    updateChapterUI();
    await yieldToUI(); // إفساح للواجهة بعد كل دفعة
  }

  // المرحلة 2: OCR — في الوضع الذكي فقط (لا يعمل أبداً في الوضع السريع)
  if (!state.cancelled && ocrCandidates.length && state.smartMode) {
    await runOCR(ocrCandidates);
  }
  ocrCandidates = null;

  hideProgress();
  updateChapterUI();
  state.busy = false;
  els.detectBtn.disabled = false;

  if (state.chapterStarts.size === 0) {
    els.chapterCount.textContent = "لم يُعثر على فصول — حدّدها يدوياً بالضغط على الصفحات";
  }
}

/* ---------- OCR اختياري (Tesseract يُحمَّل عند الحاجة فقط) ---------- */
async function getOcrWorker() {
  if (state.ocrWorker) return state.ocrWorker;
  setProgress("تحميل محرك OCR (مرة واحدة)…", 0, 0);
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js");
  state.ocrWorker = await Tesseract.createWorker("ara+eng");
  return state.ocrWorker;
}

async function runOCR(pages) {
  let worker;
  try {
    worker = await getOcrWorker();
  } catch (err) {
    alert("تعذّر تحميل محرك OCR (تحقق من الاتصال). سيُتابَع بدون فحص عميق.");
    return;
  }

  for (let i = 0; i < pages.length && !state.cancelled; i++) {
    const p = pages[i];
    setProgress("فحص عميق (OCR)…", i + 1, pages.length);
    try {
      const page = await state.pdfDoc.getPage(p);
      const base = page.getViewport({ scale: 1 });
      // تصغير الصورة: لا نتجاوز 0.7 ولا عرض 1000 بكسل
      const scale = Math.min(OCR_MAX_SCALE, OCR_MAX_WIDTH / base.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();

      const { data } = await worker.recognize(canvas);
      freeCanvas(canvas); // تحرير الذاكرة فور الانتهاء

      const title = findChapterTitle(data.text || "");
      if (title) {
        state.chapterStarts.add(p);
        state.chapterTitles[p] = title;
        updateChapterUI();
      }
    } catch { /* نتابع */ }
    await yieldToUI();
  }
}

/* ---------- التحديد اليدوي ---------- */
function toggleManualChapter(pageNum) {
  if (state.busy) return;
  if (state.chapterStarts.has(pageNum)) {
    state.chapterStarts.delete(pageNum);
    state.manualStarts.delete(pageNum);
    delete state.chapterTitles[pageNum];
  } else {
    state.chapterStarts.add(pageNum);
    state.manualStarts.add(pageNum);
  }
  updateChapterUI();
}

function updateChapterUI() {
  const thumbs = els.thumbGrid.children;
  for (const t of thumbs) {
    const p = Number(t.dataset.page);
    const isCh = state.chapterStarts.has(p);
    t.classList.toggle("chapter", isCh);
    t.classList.toggle("manual", isCh && state.manualStarts.has(p));
  }
  const n = state.chapterStarts.size;
  els.chapterCount.textContent = n ? `${n} بداية فصل` : "";
  els.splitBtn.disabled = n === 0;
}

/* ---------- التقسيم (pdf-lib) ---------- */
els.splitBtn.addEventListener("click", splitPDF);

function buildRanges() {
  const starts = [...state.chapterStarts].sort((a, b) => a - b);
  const ranges = [];
  // ما قبل أول فصل = مقدمة
  if (starts[0] > 1) {
    ranges.push({ from: 1, to: starts[0] - 1, title: "مقدمة" });
  }
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] - 1 : state.numPages;
    ranges.push({
      from, to,
      title: state.chapterTitles[from] || `الفصل ${i + 1}`,
    });
  }
  return ranges;
}

function safeName(s) {
  return s.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").slice(0, 50);
}

async function splitPDF() {
  if (state.busy || !state.originalBytes) return;
  state.busy = true;
  state.cancelled = false;
  els.splitBtn.disabled = true;
  clearResults();

  const ranges = buildRanges();
  try {
    setProgress("تحضير الملف…", 0, ranges.length);
    const srcDoc = await PDFLib.PDFDocument.load(state.originalBytes, {
      ignoreEncryption: true,
    });

    for (let i = 0; i < ranges.length && !state.cancelled; i++) {
      const r = ranges[i];
      setProgress("تقسيم الفصول…", i + 1, ranges.length);

      const out = await PDFLib.PDFDocument.create();
      const indices = [];
      for (let p = r.from; p <= r.to; p++) indices.push(p - 1);
      const copied = await out.copyPages(srcDoc, indices);
      for (const pg of copied) out.addPage(pg);

      const bytes = await out.save({ useObjectStreams: true });
      const blob = new Blob([bytes], { type: "application/pdf" });
      const name = `${safeName(state.fileName)}_${String(i + 1).padStart(2, "0")}_${safeName(r.title)}_ص${r.from}-${r.to}.pdf`;

      state.blobs.push({
        name, blob,
        url: URL.createObjectURL(blob),
        pages: `${r.from}–${r.to}`,
        size: (blob.size / 1024 / 1024).toFixed(2),
      });
      addResultRow(state.blobs[state.blobs.length - 1]);
      await yieldToUI(); // إفساح بين كل فصل
    }
  } catch (err) {
    alert("تعذّر التقسيم: " + err.message);
  }

  hideProgress();
  state.busy = false;
  els.splitBtn.disabled = false;
  if (state.blobs.length > 1) els.zipBtn.classList.remove("hidden");
}

function addResultRow(item) {
  const row = document.createElement("div");
  row.className = "result-row";
  row.innerHTML = `
    <div class="result-info">
      <strong></strong>
      <small>الصفحات ${item.pages} — ${item.size} م.ب</small>
    </div>`;
  row.querySelector("strong").textContent = item.name;
  const a = document.createElement("a");
  a.href = item.url;
  a.download = item.name;
  a.textContent = "تنزيل";
  row.appendChild(a);
  els.resultsList.appendChild(row);
}

/* ---------- ZIP (JSZip يُحمَّل عند الطلب) ---------- */
els.zipBtn.addEventListener("click", async () => {
  if (!state.blobs.length || state.busy) return;
  state.busy = true;
  els.zipBtn.disabled = true;
  try {
    setProgress("تجهيز ملف ZIP…", 0, 0);
    await loadScriptOnce("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
    const zip = new JSZip();
    for (const b of state.blobs) zip.file(b.name, b.blob);
    // STORE بدون ضغط — ملفات PDF لا تنضغط، وهذا أسرع بكثير على معالج ضعيف
    const zipBlob = await zip.generateAsync(
      { type: "blob", compression: "STORE" },
      (meta) => setProgress("تجهيز ملف ZIP…", Math.round(meta.percent), 100)
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zipBlob);
    a.download = `${safeName(state.fileName)}_فصول.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (err) {
    alert("تعذّر إنشاء ZIP: " + err.message);
  }
  hideProgress();
  els.zipBtn.disabled = false;
  state.busy = false;
});

/* ---------- إعادة التعيين ---------- */
els.resetBtn.addEventListener("click", () => resetAll(true));

function clearResults() {
  for (const b of state.blobs) URL.revokeObjectURL(b.url);
  state.blobs = [];
  els.resultsList.innerHTML = "";
  els.zipBtn.classList.add("hidden");
}

async function resetAll(clearUI) {
  state.cancelled = true;
  clearResults();
  if (state.ocrWorker) {
    try { await state.ocrWorker.terminate(); } catch {}
    state.ocrWorker = null;
  }
  if (state.pdfDoc) {
    try { await state.pdfDoc.destroy(); } catch {}
    state.pdfDoc = null;
  }
  state.originalBytes = null;
  state.chapterStarts = new Set();
  state.manualStarts = new Set();
  state.chapterTitles = {};
  state.numPages = 0;
  state.busy = false;
  renderQueue.length = 0;
  thumbObserver?.disconnect();

  if (clearUI) {
    els.thumbGrid.innerHTML = "";
    ["fileInfo", "modes", "previewSection", "splitSection", "progressCard"]
      .forEach((id) => els[id].classList.add("hidden"));
    els.fileInput.value = "";
    els.chapterCount.textContent = "";
    els.splitBtn.disabled = true;
  }
}

/* ---------- تسجيل عامل الخدمة ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
