// content.js — قلب مترجم میرزا
// قانون طلایی: فقط nodeValue گره‌های متنی و چند ویژگی متنی (alt ،title ،placeholder) عوض می‌شود.
// هرگز innerHTML، هرگز ساختار. برای همین دکمه‌ها، اسکریپت‌ها و چیدمان صفحه زنده می‌مانند.
//
// کامل بودن: بخش‌های پنهان صفحه (زبانه، آکاردئون، منوی بسته) هم ترجمه می‌شوند؛
// فقط محتوایی که با hidden یا aria-hidden پنهان شده و کدها کنار می‌مانند.
// اگر یک دسته خراب شد، همان رشته‌ها تک‌تک ترجمه می‌شوند تا چیزی جا نماند.

(function () {
  'use strict';

  // اگر اسکریپت دو بار تزریق شد (مثلاً پاپ‌آپ هم تزریق کرد)، دومی کاری نمی‌کند.
  if (window.__mirzaTranslatorLoaded) return;
  window.__mirzaTranslatorLoaded = true;

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1,
    INPUT: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, IFRAME: 1,
    SVG: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1, TEMPLATE: 1
  };

  var ATTR_NAMES = ['alt', 'title', 'placeholder'];

  var MAX_ITEMS_PER_BATCH = 20;
  var MAX_CHARS_PER_BATCH = 4000;
  var PARALLEL_WORKERS = 5;
  var MIN_TEXT_LENGTH = 2;

  var state = 'idle'; // idle | translating | translated
  var runId = 0;
  var translatedNodes = []; // [{node, original}]
  var translatedAttrs = []; // [{el, attr, original}]
  var originalTitle = null;
  var observer = null;
  var observerTimer = null;
  var cache = {};
  var cacheLoaded = false;
  var cacheDirty = false;

  // ---------- ابزارهای کوچک ----------

  function hashText(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 'h' + h.toString(36);
  }

  function isTranslatableText(text) {
    if (!text || text.trim().length < MIN_TEXT_LENGTH) return false;
    if (/^[\d\s.,;:!?()«»""''\-–—\/\\|@#%_+=*~`^$&<>]+$/.test(text.trim())) return false; // فقط عدد و نشانه
    return true;
  }

  function loadCache() {
    return new Promise(function (resolve) {
      if (cacheLoaded) return resolve();
      try {
        chrome.storage.local.get('mirza_cache', function (r) {
          cache = (r && r.mirza_cache) || {};
          cacheLoaded = true;
          resolve();
        });
      } catch (_e) {
        cacheLoaded = true;
        resolve();
      }
    });
  }

  function saveCache() {
    if (!cacheDirty) return;
    cacheDirty = false;
    try {
      chrome.storage.local.set({ mirza_cache: cache });
    } catch (_e) { /* حافظه پر شده؛ ترجمه ادامه می‌یابد، فقط کش ذخیره نمی‌شود */ }
  }

  // ---------- جمع‌آوری متن ----------

  function collectTextNodes(root) {
    var out = [];
    var walker = document.createTreeWalker(
      root || document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          var parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS[parent.tagName]) return NodeFilter.FILTER_REJECT;
          if (parent.closest('[hidden], [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
          if (!isTranslatableText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          // دیده شدن ملاک نیست: بخش پنهان با CSS (زبانه، آکاردئون) هم ترجمه می‌شود
          // تا وقتی باز شد فارسی باشد.
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    var node;
    while ((node = walker.nextNode())) out.push(node);
    return out;
  }

  function collectAttributes(root) {
    var out = [];
    var scope = root || document.body;
    if (!scope.querySelectorAll) return out;
    var els = scope.querySelectorAll('[alt], [title], [placeholder]');
    els.forEach(function (el) {
      // ویژگی روی خود عنصر است؛ INPUT و TEXTAREA هم placeholder دارند، پس رد برچسبی نیست.
      if (el.closest('[hidden], [aria-hidden="true"]')) return;
      ATTR_NAMES.forEach(function (name) {
        var v = el.getAttribute(name);
        if (!isTranslatableText(v)) return;
        if (/^(https?:\/\/|www\.|mailto:|tel:)/i.test(v.trim())) return; // نشانی؛ ترجمه ندارد
        out.push({ el: el, attr: name, text: v.trim() });
      });
    });
    return out;
  }

  // ---------- دسته‌بندی ----------

  // دسته‌ها دقیقاً به ترتیب سند ساخته می‌شوند؛ هیچ مرتب‌سازی اولویت‌داری نیست
  // تا ترجمه از بالای صفحه به پایین بیاید.
  function buildBatches(nodes) {
    var byText = new Map();
    nodes.forEach(function (node) {
      var trimmed = node.nodeValue.trim();
      if (!byText.has(trimmed)) {
        byText.set(trimmed, { text: trimmed, nodes: [] });
      }
      byText.get(trimmed).nodes.push(node);
    });

    var entries = Array.from(byText.values());

    var batches = [];
    var current = [];
    var chars = 0;
    entries.forEach(function (entry) {
      if (current.length >= MAX_ITEMS_PER_BATCH || chars + entry.text.length > MAX_CHARS_PER_BATCH) {
        if (current.length) batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(entry);
      chars += entry.text.length;
    });
    if (current.length) batches.push(current);
    return batches;
  }

  function buildAttrBatches(attrs) {
    var byText = new Map();
    attrs.forEach(function (item) {
      if (!byText.has(item.text)) {
        byText.set(item.text, { text: item.text, targets: [] });
      }
      byText.get(item.text).targets.push({ el: item.el, attr: item.attr });
    });
    var entries = Array.from(byText.values());
    var batches = [];
    var current = [];
    var chars = 0;
    entries.forEach(function (entry) {
      if (current.length >= MAX_ITEMS_PER_BATCH || chars + entry.text.length > MAX_CHARS_PER_BATCH) {
        if (current.length) batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(entry);
      chars += entry.text.length;
    });
    if (current.length) batches.push(current);
    return batches;
  }

  // ---------- جایگذاری ----------

  function applyTranslation(entry, translated) {
    entry.nodes.forEach(function (node) {
      if (!node.isConnected) return;
      var original = node.nodeValue;
      var m = original.match(/^(\s*)([\s\S]*?)(\s*)$/);
      var replaced = (m ? m[1] : '') + translated + (m ? m[3] : '');
      translatedNodes.push({ node: node, original: original });
      node.nodeValue = replaced;
    });
  }

  function applyAttrTranslation(entry, translated) {
    entry.targets.forEach(function (t) {
      if (!t.el.isConnected) return;
      translatedAttrs.push({ el: t.el, attr: t.attr, original: t.el.getAttribute(t.attr) });
      t.el.setAttribute(t.attr, translated);
    });
  }

  // ---------- راست‌چین و فونت ----------

  function enableRtl() {
    if (document.getElementById('mirza-rtl-style')) return;
    var fontUrl = function (f) {
      try { return chrome.runtime.getURL('fonts/' + f); } catch (_e) { return ''; }
    };
    var arabic = fontUrl('vazirmatn-arabic.woff2');
    var latin = fontUrl('vazirmatn-latin.woff2');
    var css = [];
    if (arabic) {
      css.push('@font-face{font-family:Vazirmatn;font-weight:100 900;font-display:swap;src:url(' + arabic + ') format("woff2");unicode-range:U+0600-06FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE80-FEFC;}');
    }
    if (latin) {
      css.push('@font-face{font-family:Vazirmatn;font-weight:100 900;font-display:swap;src:url(' + latin + ') format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}');
    }
    css.push([
      'html[dir="rtl"] body, html[dir="rtl"] p, html[dir="rtl"] h1, html[dir="rtl"] h2,',
      'html[dir="rtl"] h3, html[dir="rtl"] h4, html[dir="rtl"] h5, html[dir="rtl"] h6,',
      'html[dir="rtl"] li, html[dir="rtl"] a, html[dir="rtl"] span, html[dir="rtl"] div {',
      '  font-family: Vazirmatn, Tahoma, sans-serif !important;',
      '}'
    ].join('\n'));
    var style = document.createElement('style');
    style.id = 'mirza-rtl-style';
    style.textContent = css.join('\n');
    document.head.appendChild(style);
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.setAttribute('lang', 'fa');
  }

  function disableRtl() {
    var style = document.getElementById('mirza-rtl-style');
    if (style) style.remove();
    document.documentElement.removeAttribute('dir');
    document.documentElement.removeAttribute('lang');
  }

  // ---------- نوار پیشرفت و پیام ----------

  function ensureProgressBar() {
    var bar = document.getElementById('mirza-progress');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'mirza-progress';
    bar.innerHTML =
      '<div class="mirza-progress-inner">' +
      '<span class="mirza-progress-text">در حال ترجمه…</span>' +
      '<div class="mirza-progress-track"><div class="mirza-progress-fill"></div></div>' +
      '<button type="button" class="mirza-progress-cancel">لغو</button>' +
      '</div>';
    document.body.appendChild(bar);
    bar.querySelector('.mirza-progress-cancel').addEventListener('click', function () {
      runId++;
      state = 'idle';
      removeProgressBar();
      showToast('ترجمه لغو شد؛ متن‌های ترجمه‌شده سر جایشان ماندند.');
    });
    return bar;
  }

  function updateProgress(done, total) {
    var bar = document.getElementById('mirza-progress');
    if (!bar) return;
    var pct = total ? Math.round((done / total) * 100) : 0;
    bar.querySelector('.mirza-progress-fill').style.width = pct + '%';
    bar.querySelector('.mirza-progress-text').textContent =
      'در حال ترجمه… ' + done + ' از ' + total + ' بخش';
  }

  function removeProgressBar() {
    var bar = document.getElementById('mirza-progress');
    if (bar) bar.remove();
  }

  function showToast(text) {
    var old = document.getElementById('mirza-toast');
    if (old) old.remove();
    var toast = document.createElement('div');
    toast.id = 'mirza-toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(function () { if (toast.isConnected) toast.remove(); }, 5000);
  }

  // ---------- حرف زدن با پس‌زمینه ----------

  function translateBatchViaBackground(texts, settings) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(
          { type: 'mirza-api-translate', texts: texts, settings: settings },
          function (res) { resolve(res || { ok: false, error: 'no_response' }); }
        );
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function getSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'mirza-get-settings' }, function (settings) {
          resolve(settings || null);
        });
      } catch (_e) {
        resolve(null);
      }
    });
  }

  // ترجمه چند رشته با کش، یک بار تلاش دوباره، و بازگشت تک‌تک اگر دسته خراب شد.
  // خروجی آرایه‌ای هم‌طول ورودی است؛ جای رشته‌های ناموفق null می‌ماند.
  async function translateTexts(texts, settings) {
    var out = new Array(texts.length).fill(null);
    var missing = [];
    var missingIdx = [];
    texts.forEach(function (t, i) {
      var hit = cache[hashText(t)];
      if (hit) out[i] = hit;
      else { missing.push(t); missingIdx.push(i); }
    });
    if (!missing.length) return out;

    var res = await translateBatchViaBackground(missing, settings);
    if (!res.ok) res = await translateBatchViaBackground(missing, settings);
    if (res.ok && res.translations) {
      missing.forEach(function (t, k) {
        cache[hashText(t)] = res.translations[k];
        out[missingIdx[k]] = res.translations[k];
      });
      cacheDirty = true;
      return out;
    }

    // دسته خراب شد (مثلاً تعداد ترجمه‌ها نخورد)؛ هر رشته جدا ترجمه می‌شود،
    // موازی تا چیزی جا نماند و کند نشود.
    var singleResults = new Array(missing.length).fill(null);
    var si = 0;
    async function singleWorker() {
      while (si < missing.length) {
        var k = si++;
        var one = await translateBatchViaBackground([missing[k]], settings);
        if (one.ok && one.translations && one.translations[0]) {
          cache[hashText(missing[k])] = one.translations[0];
          singleResults[k] = one.translations[0];
          cacheDirty = true;
        }
      }
    }
    var singleWorkers = [];
    var n = Math.min(PARALLEL_WORKERS, missing.length);
    for (var s = 0; s < n; s++) singleWorkers.push(singleWorker());
    await Promise.all(singleWorkers);
    missing.forEach(function (t, k) {
      if (singleResults[k]) out[missingIdx[k]] = singleResults[k];
    });
    return out;
  }

  // اجرای دسته‌ها: گرفتن موازی، ولی جایگذاری دقیقاً به ترتیب دسته‌ها تا ترجمه
  // از بالای صفحه به پایین بیاید و وسط صفحه زودتر ننشیند.
  async function runBatches(batches, settings, myRun, applyEntry, onBatchDone, onFirstApplied) {
    var failed = 0;
    var firstDone = false;
    var slots = new Array(batches.length);
    var next = 0;
    var workers = [];
    for (var w = 0; w < PARALLEL_WORKERS; w++) {
      workers.push((async function worker() {
        while (myRun === runId) {
          var idx = next++;
          if (idx >= batches.length) break;
          slots[idx] = translateTexts(batches[idx].map(function (e) { return e.text; }), settings);
          try { await slots[idx]; } catch (_e) { /* translateTexts همیشه آرایه برمی‌گرداند */ }
        }
      })());
    }
    for (var i = 0; i < batches.length; i++) {
      if (myRun !== runId) break;
      if (!slots[i]) break; // لغو شده پیش از شروع این دسته
      var results = (await slots[i]) || [];
      var appliedAny = false;
      batches[i].forEach(function (entry, k) {
        if (results[k]) { applyEntry(entry, results[k]); appliedAny = true; }
        else failed++;
      });
      if (appliedAny && !firstDone) {
        firstDone = true;
        if (onFirstApplied) onFirstApplied();
      }
      if (onBatchDone) onBatchDone();
    }
    await Promise.all(workers);
    return { failed: failed };
  }

  function translateTitle(settings, myRun) {
    if (!document.title || !document.title.trim() || originalTitle !== null) return;
    originalTitle = document.title;
    translateBatchViaBackground([document.title.trim()], settings).then(function (res) {
      if (myRun === runId && res.ok && res.translations && res.translations[0]) {
        document.title = res.translations[0];
      }
    });
  }

  function isStale() {
    try { return !chrome.runtime || !chrome.runtime.id; } catch (_e) { return true; }
  }

  // ---------- جریان اصلی ----------

  async function translatePage() {
    if (state === 'translating') return;
    if (state === 'translated') { restorePage(); return; }

    var settings = await getSettings();
    if (!settings || !settings.apiKey) {
      if (isStale()) {
        showToast('افزونه به‌روز شد؛ این صفحه را یک بار تازه کن.');
      } else {
        showToast('کلید API را در تنظیمات افزونه بگذار؛ بعد دوباره بزن.');
        try { chrome.runtime.sendMessage({ type: 'mirza-open-options' }); } catch (_e) {}
      }
      return;
    }

    state = 'translating';
    var myRun = ++runId;
    await loadCache();

    var nodes = collectTextNodes(document.body);
    var attrs = collectAttributes(document.body);
    if (!nodes.length && !attrs.length) {
      state = 'idle';
      showToast('متن قابل ترجمه‌ای در این صفحه پیدا نشد.');
      return;
    }

    var textBatches = buildBatches(nodes);
    var attrBatches = buildAttrBatches(attrs);
    var totalBatches = textBatches.length + attrBatches.length;
    var doneBatches = 0;
    var failedTotal = 0;
    var onBatchDone = function () { doneBatches++; updateProgress(doneBatches, totalBatches); };
    var rtlOn = false;
    var onFirstApplied = function () {
      rtlOn = true;
      enableRtl();
      translateTitle(settings, myRun);
    };

    ensureProgressBar();
    updateProgress(0, totalBatches);

    var r1 = await runBatches(textBatches, settings, myRun, applyTranslation, onBatchDone, onFirstApplied);
    if (myRun !== runId) return; // لغو شده بود
    failedTotal += r1.failed;

    var r2 = await runBatches(attrBatches, settings, myRun, applyAttrTranslation, onBatchDone, null);
    if (myRun !== runId) return;
    failedTotal += r2.failed;

    // صفحه‌ای که فقط ویژگی متنی دارد و متن ندارد: راست‌چین و عنوان این‌جا می‌آید
    if (!rtlOn && (translatedNodes.length || translatedAttrs.length)) onFirstApplied();

    saveCache();
    removeProgressBar();
    if (translatedNodes.length || translatedAttrs.length) {
      state = 'translated';
      startObserver(settings);
      showToast(
        failedTotal > 0
          ? 'ترجمه تمام شد؛ ' + failedTotal + ' جمله ترجمه نشد. اتصال را بررسی کن و دوباره بزن.'
          : 'ترجمه تمام شد. برای برگشت به انگلیسی، دوباره روی دکمه بزن.'
      );
    } else {
      state = 'idle';
      showToast('ترجمه نشد؛ اتصال یا کلید را در تنظیمات بررسی کن.');
    }
  }

  function restorePage() {
    runId++;
    translatedNodes.forEach(function (item) {
      if (item.node.isConnected) item.node.nodeValue = item.original;
    });
    translatedNodes = [];
    translatedAttrs.forEach(function (item) {
      if (item.el.isConnected) item.el.setAttribute(item.attr, item.original);
    });
    translatedAttrs = [];
    if (originalTitle !== null) { document.title = originalTitle; originalTitle = null; }
    disableRtl();
    stopObserver();
    state = 'idle';
    showToast('به متن اصلی برگشت.');
  }

  // ---------- دیده‌بان متن‌های تازه ----------

  function startObserver(settings) {
    stopObserver();
    observer = new MutationObserver(function () {
      if (observerTimer) clearTimeout(observerTimer);
      observerTimer = setTimeout(function () { translateNewNodes(settings); }, 800);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (observerTimer) { clearTimeout(observerTimer); observerTimer = null; }
  }

  async function translateNewNodes(settings) {
    if (state !== 'translated') return;
    var myRun = runId;
    var nodes = collectTextNodes(document.body).filter(function (node) {
      return !translatedNodes.some(function (item) { return item.node === node; });
    });
    if (!nodes.length) return;
    var batches = buildBatches(nodes);
    await runBatches(batches, settings, myRun, applyTranslation, null, null);
    saveCache();
  }

  // ---------- پیام از پاپ‌آپ ----------

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.type === 'mirza-translate') {
      translatePage();
      sendResponse({ ok: true, state: state });
    } else if (msg.type === 'mirza-status') {
      // اگر زمینه افزونه مرده باشد (زبانه پیش از به‌روزرسانی باز شده)،
      // getManifest خطا می‌دهد. در این حالت اصلاً جواب نمی‌دهیم تا پاپ‌آپ
      // اسکریپت تازه را تزریق کند و جواب او برسد؛ وگرنه جواب کهنه همیشه
      // زودتر می‌رسد و جلوی تازه را می‌گیرد.
      try {
        sendResponse({ ok: true, state: state, version: chrome.runtime.getManifest().version });
      } catch (_e) {
        // عمداً بدون sendResponse
      }
    }
    return false;
  });
})();
