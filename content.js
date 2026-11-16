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

  // پنج کارگر موازی، ولی هر کارگر در هر لحظه فقط یک درخواست دارد
  // (نصف کردن و تک‌تک پشت سر هم‌اند) تا سقف درخواست هم‌زمان درگاه
  // (۱۰ در ثانیه و سقف هم‌زمان) رد نشود. دسته کوچک‌تر هم جواب مدل را
  // کوتاه‌تر و سالم‌تر می‌کند (دسته ۲۰تایی گاهی JSON خراب برمی‌گرداند).
  var MAX_ITEMS_PER_BATCH = 12;
  var MAX_CHARS_PER_BATCH = 2500;
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
  var lastTranslateError = null; // متن فارسی آخرین خطای ترجمه، برای پیام و پاپ‌آپ
  var fatalError = null; // خطای کشنده (مدل خاموش، کلید اشتباه)؛ کل ترجمه همان‌جا می‌ایستد
  var beginnerDone = false; // بازنویسی مبتدی روی ترجمه کنونی انجام شده
  var currentRunKind = null; // 'translate' | 'simplify' — دکمه لغو بداند چه را لغو می‌کند
  var standardTitle = null; // عنوان فارسی معمولی (برای پشتیبان)
  var beginnerTitle = null; // عنوان ساده‌شده (برای پشتیبان)

  // ---------- ابزارهای کوچک ----------

  function toFaDigits(n) {
    return String(n).replace(/[0-9]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[+d]; });
  }

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

  // ---------- پشتیبان ترجمه ----------
  // بعد از هر ترجمه، یک نسخه از ترجمه همین صفحه ذخیره می‌شود تا با رفرش یا
  // بستن صفحه از دست نرود؛ هم ترجمه معمولی، هم ساده. بازیابی خودکار است و
  // بدون درخواست تازه انجام می‌شود. پشتیبان برای هر نشانی جدا نگه داشته
  // می‌شود و فقط ۵۰ صفحه آخر می‌مانند.

  var MAX_BACKUPS = 50;

  function backupUrl() {
    try {
      var u = new URL(location.href);
      u.hash = '';
      var drop = [];
      u.searchParams.forEach(function (_v, k) {
        if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) drop.push(k);
      });
      drop.forEach(function (k) { u.searchParams.delete(k); });
      return u.toString();
    } catch (_e) {
      return String(location.href).split('#')[0];
    }
  }

  function backupKey() {
    return 'mirza_backup_' + hashText(backupUrl());
  }

  function storageGet(key) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(key, function (r) { resolve(r ? r[key] : null); });
      } catch (_e) { resolve(null); }
    });
  }

  async function saveBackup(mode) {
    if (state !== 'translated' || !translatedNodes.length) return;
    var key = backupKey();
    var prev = await storageGet(key);
    var standard = {};
    var beginner = (prev && prev.beginner) || {};
    translatedNodes.forEach(function (item) {
      if (!item.node.isConnected || item.standard === undefined) return;
      var en = String(item.original).trim();
      if (isTranslatableText(en)) standard[hashText(en)] = item.standard;
      if (beginnerDone) {
        var cur = item.node.nodeValue.trim();
        if (isTranslatableText(cur)) beginner[hashText(String(item.standard).trim())] = cur;
      }
    });
    if (!Object.keys(standard).length) return;
    var rec = {
      url: backupUrl(),
      titleEn: originalTitle,
      titleFa: standardTitle,
      titleBeginner: beginnerDone ? beginnerTitle : ((prev && prev.titleBeginner) || null),
      mode: mode,
      standard: standard,
      beginner: beginner,
      savedAt: Date.now()
    };
    try {
      var obj = {};
      obj[key] = rec;
      chrome.storage.local.set(obj);
    } catch (_e) { /* ذخیره نشد؛ ترجمه سر جایش می‌ماند */ }
    // فهرست پشتیبان‌ها برای هرس؛ فقط فراداده است، نه خود ترجمه‌ها.
    try {
      chrome.storage.local.get('mirza_backup_index', function (r) {
        var idx = (r && r.mirza_backup_index) || [];
        idx = idx.filter(function (e) { return e.key !== key; });
        idx.unshift({ key: key, url: rec.url, title: rec.titleEn || rec.url, mode: mode, savedAt: rec.savedAt });
        var pruned = idx.slice(MAX_BACKUPS);
        idx = idx.slice(0, MAX_BACKUPS);
        try { chrome.storage.local.set({ mirza_backup_index: idx }); } catch (_e2) {}
        pruned.forEach(function (e) {
          try { chrome.storage.local.remove(e.key); } catch (_e3) {}
        });
      });
    } catch (_e) {}
  }

  function deleteBackup() {
    try {
      var key = backupKey();
      chrome.storage.local.remove(key);
      chrome.storage.local.get('mirza_backup_index', function (r) {
        var idx = (r && r.mirza_backup_index) || [];
        var next = idx.filter(function (e) { return e.key !== key; });
        if (next.length !== idx.length) {
          try { chrome.storage.local.set({ mirza_backup_index: next }); } catch (_e2) {}
        }
      });
    } catch (_e) {}
  }

  // اگر برای این نشانی پشتیبان هست، صفحه با همان ترجمه بالا می‌آید؛ بدون
  // درخواست تازه. متن‌هایی که در پشتیبان نیستند انگلیسی می‌مانند تا با
  // ترجمه تازه (از کش یا درگاه) پر شوند.
  async function restoreFromBackup() {
    if (state !== 'idle') return;
    var rec = await storageGet(backupKey());
    if (!rec || !rec.standard || !Object.keys(rec.standard).length) return;
    var nodes = collectTextNodes(document.body);
    var applied = 0;
    nodes.forEach(function (node) {
      var en = node.nodeValue.trim();
      if (!isTranslatableText(en)) return;
      var std = rec.standard[hashText(en)];
      if (std === undefined) return;
      var target = std;
      if (rec.mode === 'beginner' && rec.beginner) {
        var b = rec.beginner[hashText(String(std).trim())];
        if (b !== undefined) target = b;
      }
      var m = node.nodeValue.match(/^(\s*)([\s\S]*?)(\s*)$/);
      translatedNodes.push({ node: node, original: node.nodeValue, standard: std });
      node.nodeValue = (m ? m[1] : '') + target + (m ? m[3] : '');
      applied++;
    });
    if (!applied) return;
    if (rec.mode === 'beginner' && rec.titleBeginner) {
      originalTitle = rec.titleEn || document.title;
      beginnerTitle = rec.titleBeginner;
      standardTitle = rec.titleFa || null;
      document.title = rec.titleBeginner;
    } else if (rec.titleFa) {
      originalTitle = rec.titleEn || document.title;
      standardTitle = rec.titleFa;
      beginnerTitle = rec.titleBeginner || null;
      document.title = rec.titleFa;
    }
    state = 'translated';
    beginnerDone = (rec.mode === 'beginner');
    enableRtl();
    var settings = await Promise.race([
      getSettings(),
      new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 2000); })
    ]);
    if (settings && settings.apiKey) startObserver(settings);
    showToast(rec.mode === 'beginner' ? 'ترجمه ساده از پشتیبان برگشت.' : 'ترجمه از پشتیبان برگشت.');
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
          // متن‌های خود افزونه (پیام، نوار پیشرفت) ترجمه نمی‌شوند؛
          // وگرنه دیده‌بان آن‌ها را هم می‌فرستاد.
          if (parent.closest('#mirza-progress, #mirza-toast')) return NodeFilter.FILTER_REJECT;
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
  // firstSmall: دسته اول کوچک‌تر می‌شود تا بالای صفحه زودتر دیده شود.
  function buildBatches(nodes, firstSmall) {
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
      var capItems = (firstSmall && batches.length === 0) ? 8 : MAX_ITEMS_PER_BATCH;
      var capChars = (firstSmall && batches.length === 0) ? 1500 : MAX_CHARS_PER_BATCH;
      if (current.length >= capItems || chars + entry.text.length > capChars) {
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
      // standard را نگه می‌داریم تا «بازگشت به ترجمه معمولی» بدون درخواست تازه کار کند
      translatedNodes.push({ node: node, original: original, standard: translated });
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
      removeProgressBar();
      if (currentRunKind === 'simplify') {
        currentRunKind = null;
        showToast('ساده‌سازی لغو شد؛ ترجمه سر جایش ماند.');
      } else {
        currentRunKind = null;
        state = 'idle';
        showToast('ترجمه لغو شد؛ متن‌های ترجمه‌شده سر جایشان ماندند.');
      }
    });
    return bar;
  }

  // درصد با وزن نویسه است، نه تعداد دسته؛ وگرنه دسته ۲۰ جمله کوتاه با دسته
  // ۴۰۰۰ نویسه‌ای یکسان شمرده می‌شد و عدد با چیزی که روی صفحه می‌بینی نمی‌خواند.
  function updateProgress(doneChars, totalChars, doneItems, totalItems, label) {
    var bar = document.getElementById('mirza-progress');
    if (!bar) return;
    var pct = totalChars ? Math.round((doneChars / totalChars) * 100) : 0;
    bar.querySelector('.mirza-progress-fill').style.width = pct + '%';
    bar.querySelector('.mirza-progress-text').textContent =
      (label || 'در حال ترجمه…') + ' ' + toFaDigits(pct) + '٪ (' + toFaDigits(doneItems) + ' از ' + toFaDigits(totalItems) + ')';
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

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function translateBatchViaBackground(texts, settings, mode) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(
          { type: 'mirza-api-translate', texts: texts, settings: settings, mode: mode },
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

  // ترجمه چند رشته با کش و یک بار تلاش دوباره.
  // اگر دسته خراب شد، یک بار نصف می‌شود تا رشته خراب جدا بیفتد؛ اگر نیمه‌ای
  // هم خراب شد، همان نیمه تک‌تک می‌رود. خطای کشنده (مدل خاموش، کلید
  // اشتباه) همان‌جا کل ترجمه را می‌ایستاند تا درخواست بیهوده نرود.
  // خروجی آرایه‌ای هم‌طول ورودی است؛ جای رشته‌های ناموفق null می‌ماند.
  // حالت مبتدی کش جدا دارد (کلید 's' + هش ورودی فارسی) تا ترجمه ساده جای
  // ترجمه معمولی را نگیرد و برعکس؛ ورودی‌اش فارسی جاری روی صفحه است،
  // خروجی‌اش فارسی ساده‌تر. ('b' مال نسخه ۱٫۶٫۰ بود که ورودی‌اش انگلیسی بود.)
  function cacheKey(text, mode) {
    return mode === 'beginner' ? 's' + hashText(text) : hashText(text);
  }

  async function translateTexts(texts, settings, depth, mode) {
    var out = new Array(texts.length).fill(null);
    var missing = [];
    var missingIdx = [];
    texts.forEach(function (t, i) {
      var hit = cache[cacheKey(t, mode)];
      if (hit) out[i] = hit;
      else { missing.push(t); missingIdx.push(i); }
    });
    if (!missing.length) return out;

    var res = await translateBatchViaBackground(missing, settings, mode);
    if (!res.ok && !res.fatal && !depth) {
      if (res.error === 'rate_limited') await sleep(5000);
      res = await translateBatchViaBackground(missing, settings, mode);
    }
    if (res.ok && res.translations) {
      missing.forEach(function (t, k) {
        cache[cacheKey(t, mode)] = res.translations[k];
        out[missingIdx[k]] = res.translations[k];
      });
      cacheDirty = true;
      return out;
    }
    if (res && res.fatal) {
      fatalError = res.errorText || 'مدل در دسترس نیست.';
      return out;
    }
    if (res && res.errorText) lastTranslateError = res.errorText;
    // درگاه شلوغ است (429): نصف کردن و تک‌تک فقط بار را بیشتر می‌کند؛
    // همین دسته را برای تلاش بعدی می‌گذاریم و برمی‌گردیم.
    if (res && res.error === 'rate_limited') return out;
    if (missing.length === 1) return out;

    if (!depth) {
      // دسته خراب شد (مثلاً تعداد ترجمه‌ها نخورد)؛ یک بار نصف می‌کنیم تا
      // رشته خراب جدا بیفتد. دو نیمه پشت سر هم می‌روند تا هم‌زمان شلوغ نشود.
      var mid = Math.ceil(missing.length / 2);
      var left = await translateTexts(missing.slice(0, mid), settings, 1, mode);
      var right = await translateTexts(missing.slice(mid), settings, 1, mode);
      left.forEach(function (tr, k) { if (tr) out[missingIdx[k]] = tr; });
      right.forEach(function (tr, k) { if (tr) out[missingIdx[mid + k]] = tr; });
      return out;
    }

    // نیمه هم خراب شد؛ هر رشته جدا ترجمه می‌شود، پشت سر هم تا درگاه شلوغ نشود.
    var singleResults = new Array(missing.length).fill(null);
    var si = 0;
    async function singleWorker() {
      while (si < missing.length && !fatalError) {
        var k = si++;
        var one = await translateBatchViaBackground([missing[k]], settings, mode);
        if (one.ok && one.translations && one.translations[0]) {
          cache[cacheKey(missing[k], mode)] = one.translations[0];
          singleResults[k] = one.translations[0];
          cacheDirty = true;
        } else if (one && one.fatal) {
          fatalError = one.errorText || 'مدل در دسترس نیست.';
        } else if (one && one.error === 'rate_limited') {
          // درگاه شلوغ شد؛ بقیه تک‌ها را نمی‌زنیم تا آرام شود.
          si = missing.length;
          if (one.errorText) lastTranslateError = one.errorText;
        }
      }
    }
    await singleWorker();
    missing.forEach(function (t, k) {
      if (singleResults[k]) out[missingIdx[k]] = singleResults[k];
    });
    return out;
  }

  // اجرای دسته‌ها: گرفتن موازی، ولی جایگذاری دقیقاً به ترتیب دسته‌ها تا ترجمه
  // از بالای صفحه به پایین بیاید و وسط صفحه زودتر ننشیند.
  async function runBatches(batches, settings, myRun, applyEntry, onBatchDone, onFirstApplied, mode) {
    var failed = 0;
    var firstDone = false;
    var slots = new Array(batches.length);
    var next = 0;
    var workers = [];
    for (var w = 0; w < PARALLEL_WORKERS; w++) {
      workers.push((async function worker() {
        while (myRun === runId && !fatalError) {
          var idx = next++;
          if (idx >= batches.length) break;
          slots[idx] = translateTexts(batches[idx].map(function (e) { return e.text; }), settings, 0, mode);
          try { await slots[idx]; } catch (_e) { /* translateTexts همیشه آرایه برمی‌گرداند */ }
        }
      })());
    }
    for (var i = 0; i < batches.length; i++) {
      if (myRun !== runId) break;
      if (fatalError) break; // خطای کشنده: بقیه دسته‌ها بیهوده‌اند
      if (!slots[i]) break; // لغو شده پیش از شروع این دسته
      var results = (await slots[i]) || [];
      var appliedAny = false;
      var appliedChars = 0;
      var appliedItems = 0;
      batches[i].forEach(function (entry, k) {
        if (results[k]) {
          applyEntry(entry, results[k]);
          appliedAny = true;
          appliedChars += entry.text.length;
          appliedItems++;
        }
        else failed++;
      });
      if (appliedAny && !firstDone) {
        firstDone = true;
        if (onFirstApplied) onFirstApplied();
      }
      if (onBatchDone) onBatchDone(appliedChars, appliedItems);
    }
    await Promise.all(workers);
    return { failed: failed };
  }

  function translateTitle(settings, myRun) {
    if (!document.title || !document.title.trim() || originalTitle !== null) return;
    originalTitle = document.title;
    translateBatchViaBackground([document.title.trim()], settings).then(function (res) {
      if (myRun === runId && res.ok && res.translations && res.translations[0]) {
        standardTitle = res.translations[0];
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
    currentRunKind = 'translate';
    beginnerDone = false;
    standardTitle = null;
    beginnerTitle = null;
    lastTranslateError = null;
    fatalError = null;
    await loadCache();

    var nodes = collectTextNodes(document.body);
    var attrs = collectAttributes(document.body);
    if (!nodes.length && !attrs.length) {
      state = 'idle';
      showToast('متن قابل ترجمه‌ای در این صفحه پیدا نشد.');
      return;
    }

    var textBatches = buildBatches(nodes, true);
    var attrBatches = buildAttrBatches(attrs);
    var totalChars = 0;
    var totalItems = 0;
    textBatches.concat(attrBatches).forEach(function (batch) {
      batch.forEach(function (entry) { totalChars += entry.text.length; totalItems++; });
    });
    var doneChars = 0;
    var doneItems = 0;
    var failedTotal = 0;
    var onBatchDone = function (chars, items) {
      doneChars += chars;
      doneItems += items;
      updateProgress(doneChars, totalChars, doneItems, totalItems);
    };
    var rtlOn = false;
    var onFirstApplied = function () {
      rtlOn = true;
      enableRtl();
    };

    ensureProgressBar();
    updateProgress(0, totalChars, 0, totalItems);

    var r1 = await runBatches(textBatches, settings, myRun, applyTranslation, onBatchDone, onFirstApplied);
    if (myRun !== runId) return; // لغو شده بود
    failedTotal += r1.failed;

    var r2 = { failed: 0 };
    if (!fatalError) {
      r2 = await runBatches(attrBatches, settings, myRun, applyAttrTranslation, onBatchDone, null);
      if (myRun !== runId) return;
      failedTotal += r2.failed;
    }

    // صفحه‌ای که فقط ویژگی متنی دارد و متن ندارد: راست‌چین این‌جا می‌آید
    if (!rtlOn && (translatedNodes.length || translatedAttrs.length)) onFirstApplied();

    // عنوان صفحه آخر ترجمه می‌شود تا هم‌زمان با دسته‌ها درخواست اضافه نرود؛
    // و فقط وقتی چیزی ترجمه شده باشد.
    if (!fatalError && (translatedNodes.length || translatedAttrs.length)) translateTitle(settings, myRun);

    saveCache();
    currentRunKind = null;
    removeProgressBar();
    if (fatalError) {
      // خطای کشنده: یا هیچ‌چیز ترجمه نشده، یا وسط کار متوقف شده؛ پیامش خودش راهنماست.
      state = (translatedNodes.length || translatedAttrs.length) ? 'translated' : 'idle';
      if (state === 'translated') { startObserver(settings); saveBackup('standard'); }
      showToast(fatalError);
    } else if (translatedNodes.length || translatedAttrs.length) {
      state = 'translated';
      startObserver(settings);
      saveBackup('standard');
      showToast(
        failedTotal > 0
          ? 'ترجمه تمام شد؛ ' + toFaDigits(failedTotal) + ' جمله ترجمه نشد. ' + (lastTranslateError || 'اتصال را بررسی کن و دوباره بزن.')
          : 'ترجمه تمام شد. برای برگشت به انگلیسی، دوباره روی دکمه بزن.'
      );
    } else {
      state = 'idle';
      showToast(lastTranslateError || 'ترجمه نشد؛ اتصال یا کلید را در تنظیمات بررسی کن.');
    }
  }

  // ---------- ساده‌سازی برای مبتدی ----------

  // ورودی ساده‌سازی، فارسی جاری روی صفحه است (ترجمه معمولی)، نه انگلیسی؛
  // مدل همان متن را ساده‌تر می‌نویسد، پس تغییر روی صفحه دیده می‌شود.
  // ترجمه معمولی هر گره در translatedNodes.standard مانده، پس بازگشت به آن
  // بدون درخواست تازه انجام می‌شود.

  // دسته‌بندی مثل ترجمه، ولی بدون دسته اول کوچک؛ بالای صفحه همین حالا فارسی است.
  function buildSimpleBatches(entries) {
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

  function applyBeginnerEntry(entry, translated) {
    entry.nodes.forEach(function (node) {
      if (!node.isConnected) return;
      var m = node.nodeValue.match(/^(\s*)([\s\S]*?)(\s*)$/);
      node.nodeValue = (m ? m[1] : '') + translated + (m ? m[3] : '');
    });
  }

  // ساده‌سازی بی‌صدا برای گره‌های تازه‌ای که دیده‌بان بعد از ساده‌سازی می‌آورد؛
  // نوار پیشرفت و پیام ندارد و فقط گره‌هایی که ترجمه معمولی‌شان ثبت شده ساده می‌شوند.
  async function simplifyNodes(nodes, settings, myRun) {
    var byText = new Map();
    nodes.forEach(function (node) {
      if (!node.isConnected) return;
      if (!translatedNodes.some(function (item) { return item.node === node; })) return;
      var cur = node.nodeValue.trim();
      if (!isTranslatableText(cur)) return;
      if (!byText.has(cur)) byText.set(cur, { text: cur, nodes: [] });
      byText.get(cur).nodes.push(node);
    });
    var entries = Array.from(byText.values());
    if (!entries.length) return;
    var batches = buildSimpleBatches(entries);
    await runBatches(batches, settings, myRun, applyBeginnerEntry, null, null, 'beginner');
  }
  async function simplifyForBeginner() {
    if (state !== 'translated' || beginnerDone) return;
    var settings = await getSettings();
    if (!settings || !settings.apiKey) {
      showToast('کلید API را در تنظیمات افزونه بگذار؛ بعد دوباره بزن.');
      return;
    }
    var myRun = ++runId;
    currentRunKind = 'simplify';
    lastTranslateError = null;
    fatalError = null;
    await loadCache();

    var byText = new Map();
    translatedNodes.forEach(function (item) {
      if (!item.node.isConnected) return;
      var current = item.node.nodeValue.trim();
      if (!isTranslatableText(current)) return;
      if (!byText.has(current)) byText.set(current, { text: current, nodes: [] });
      byText.get(current).nodes.push(item.node);
    });
    var entries = Array.from(byText.values());
    if (!entries.length) { currentRunKind = null; return; }
    var batches = buildSimpleBatches(entries);

    var totalChars = 0;
    var totalItems = 0;
    batches.forEach(function (batch) {
      batch.forEach(function (entry) { totalChars += entry.text.length; totalItems++; });
    });
    var doneChars = 0;
    var doneItems = 0;
    var failedTotal = 0;
    var onBatchDone = function (charsDone, itemsDone) {
      doneChars += charsDone;
      doneItems += itemsDone;
      updateProgress(doneChars, totalChars, doneItems, totalItems, 'در حال ساده‌سازی برای مبتدی…');
    };
    ensureProgressBar();
    updateProgress(0, totalChars, 0, totalItems, 'در حال ساده‌سازی برای مبتدی…');

    var applyBeginner = applyBeginnerEntry;
    var r = await runBatches(batches, settings, myRun, applyBeginner, onBatchDone, null, 'beginner');
    if (myRun !== runId) return; // لغو شده بود
    failedTotal += r.failed;

    // عنوان صفحه هم با همان لحن ساده می‌شود (ورودی‌اش عنوان فارسی جاری است).
    // عنوان هم کش جدا دارد؛ وگرنه هر بار ساده‌سازی دوباره یک درخواست می‌رود.
    if (!fatalError) {
      var currentTitle = document.title.trim();
      if (currentTitle) {
        var titleKey = cacheKey(currentTitle, 'beginner');
        if (cache[titleKey]) {
          beginnerTitle = cache[titleKey];
          document.title = cache[titleKey];
        } else {
          translateBatchViaBackground([currentTitle], settings, 'beginner').then(function (res) {
            if (myRun === runId && res.ok && res.translations && res.translations[0]) {
              cache[titleKey] = res.translations[0];
              beginnerTitle = res.translations[0];
              document.title = res.translations[0];
            }
          });
        }
      }
    }

    currentRunKind = null;
    saveCache();
    removeProgressBar();
    if (fatalError) {
      showToast(fatalError);
    } else if (failedTotal > 0) {
      showToast('ساده‌سازی ناتمام ماند؛ ' + toFaDigits(failedTotal) + ' جمله ساده نشد. ' + (lastTranslateError || 'دوباره بزن.'));
    } else {
      beginnerDone = true;
      saveBackup('beginner');
      showToast('ساده و روان شد؛ انگار یک نویسنده ایرانی برای یک مبتدی نوشته.');
    }
  }

  // بازگشت به ترجمه معمولی: بدون درخواست تازه، از standard ثبت‌شده هر گره.
  function restoreStandard() {
    if (state !== 'translated' || !beginnerDone) return;
    translatedNodes.forEach(function (item) {
      if (!item.node.isConnected || item.standard === undefined) return;
      var m = item.node.nodeValue.match(/^(\s*)([\s\S]*?)(\s*)$/);
      item.node.nodeValue = (m ? m[1] : '') + item.standard + (m ? m[3] : '');
    });
    beginnerDone = false;
    saveBackup('standard');
    showToast('به ترجمه معمولی برگشت.');
  }

  function restorePage() {
    runId++;
    currentRunKind = null;
    beginnerDone = false;
    standardTitle = null;
    beginnerTitle = null;
    removeProgressBar();
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
    deleteBackup();
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
    if (myRun !== runId) return;
    // اگر صفحه در حالت مبتدی است، گره تازه هم همان لحن ساده را می‌گیرد.
    if (beginnerDone) await simplifyNodes(nodes, settings, myRun);
    saveCache();
  }

  // ---------- پیام از پاپ‌آپ ----------

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.type === 'mirza-translate') {
      translatePage();
      sendResponse({ ok: true, state: state });
    } else if (msg.type === 'mirza-simplify') {
      simplifyForBeginner();
      sendResponse({ ok: true });
    } else if (msg.type === 'mirza-restore-standard') {
      restoreStandard();
      sendResponse({ ok: true });
    } else if (msg.type === 'mirza-status') {
      // اگر زمینه افزونه مرده باشد (زبانه پیش از به‌روزرسانی باز شده)،
      // getManifest خطا می‌دهد. در این حالت اصلاً جواب نمی‌دهیم تا پاپ‌آپ
      // اسکریپت تازه را تزریق کند و جواب او برسد؛ وگرنه جواب کهنه همیشه
      // زودتر می‌رسد و جلوی تازه را می‌گیرد.
      try {
        sendResponse({ ok: true, state: state, version: chrome.runtime.getManifest().version, error: fatalError || lastTranslateError, beginner: beginnerDone, simplifying: currentRunKind === 'simplify' });
      } catch (_e) {
        // عمداً بدون sendResponse
      }
    }
    return false;
  });

  // اگر برای این نشانی پشتیبان ترجمه هست، صفحه با همان ترجمه بالا می‌آید؛
  // بدون درخواست تازه.
  restoreFromBackup();
})();
