// content.js — قلب مترجم میرزا
// قانون طلایی: فقط nodeValue گره‌های متنی عوض می‌شود. هرگز innerHTML، هرگز ساختار.
// برای همین دکمه‌ها، اسکریپت‌ها و چیدمان صفحه زنده می‌مانند.

(function () {
  'use strict';

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1,
    INPUT: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, IFRAME: 1,
    SVG: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1, TEMPLATE: 1
  };

  var MAX_ITEMS_PER_BATCH = 10;
  var MAX_CHARS_PER_BATCH = 1500;
  var PARALLEL_WORKERS = 3;
  var MIN_TEXT_LENGTH = 2;

  var state = 'idle'; // idle | translating | translated
  var runId = 0;
  var translatedNodes = []; // [{node, original}]
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

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('[hidden]')) return false;
    var cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    return el.getClientRects().length > 0;
  }

  function priorityOf(el) {
    if (el.closest('article, main, [role="main"], .post-content, .entry-content, .article-body')) return 0;
    if (el.closest('header, nav, footer, aside, .sidebar, .menu, .nav')) return 2;
    return 1;
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
          if (parent.closest('[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
          var text = node.nodeValue;
          if (!text || text.trim().length < MIN_TEXT_LENGTH) return NodeFilter.FILTER_REJECT;
          if (/^[\d\s.,;:!?()«»""''\-–—\/\\|@#%_+=*~`^$&<>]+$/.test(text.trim())) {
            return NodeFilter.FILTER_REJECT; // فقط عدد و نشانه؛ ترجمه ندارد
          }
          if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    var node;
    while ((node = walker.nextNode())) out.push(node);
    return out;
  }

  // ---------- دسته‌بندی ----------

  function buildBatches(nodes) {
    var byText = new Map();
    nodes.forEach(function (node) {
      var trimmed = node.nodeValue.trim();
      if (!byText.has(trimmed)) {
        byText.set(trimmed, { text: trimmed, nodes: [], priority: priorityOf(node.parentElement) });
      }
      var entry = byText.get(trimmed);
      entry.nodes.push(node);
      entry.priority = Math.min(entry.priority, priorityOf(node.parentElement));
    });

    var entries = Array.from(byText.values());
    entries.sort(function (a, b) { return a.priority - b.priority; });

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
    return { batches: batches, byText: byText };
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

  // ---------- راست‌چین و فونت ----------

  function enableRtl() {
    if (document.getElementById('mirza-rtl-style')) return;
    var link = document.createElement('link');
    link.id = 'mirza-font-link';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;700&display=swap';
    document.head.appendChild(link);
    var style = document.createElement('style');
    style.id = 'mirza-rtl-style';
    style.textContent = [
      'html[dir="rtl"] body, html[dir="rtl"] p, html[dir="rtl"] h1, html[dir="rtl"] h2,',
      'html[dir="rtl"] h3, html[dir="rtl"] h4, html[dir="rtl"] h5, html[dir="rtl"] h6,',
      'html[dir="rtl"] li, html[dir="rtl"] a, html[dir="rtl"] span, html[dir="rtl"] div {',
      '  font-family: Vazirmatn, Tahoma, sans-serif !important;',
      '}'
    ].join('\n');
    document.head.appendChild(style);
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.setAttribute('lang', 'fa');
  }

  function disableRtl() {
    var style = document.getElementById('mirza-rtl-style');
    if (style) style.remove();
    var link = document.getElementById('mirza-font-link');
    if (link) link.remove();
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

  // ---------- ترجمه یک دسته ----------

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

  // ---------- جریان اصلی ----------

  async function translatePage() {
    if (state === 'translating') return;
    if (state === 'translated') { restorePage(); return; }

    var settings = await getSettings();
    if (!settings || !settings.apiKey) {
      showToast('کلید API را در تنظیمات افزونه بگذار؛ بعد دوباره بزن.');
      try { chrome.runtime.sendMessage({ type: 'mirza-open-options' }); } catch (_e) {}
      return;
    }

    state = 'translating';
    var myRun = ++runId;
    await loadCache();

    var nodes = collectTextNodes(document.body);
    if (!nodes.length) {
      state = 'idle';
      showToast('متن قابل ترجمه‌ای در این صفحه پیدا نشد.');
      return;
    }

    var built = buildBatches(nodes);
    var batches = built.batches;
    var byText = built.byText;

    ensureProgressBar();
    var done = 0;
    var failed = 0;
    var firstApplied = false;

    var queue = batches.slice();
    var workers = [];
    for (var w = 0; w < PARALLEL_WORKERS; w++) {
      workers.push((async function worker() {
        while (queue.length && myRun === runId) {
          var batch = queue.shift();
          var texts = batch.map(function (e) { return e.text; });

          // اول از کش بردار
          var missing = [];
          var missingIdx = [];
          var cached = {};
          texts.forEach(function (t, i) {
            var hit = cache[hashText(t)];
            if (hit) cached[i] = hit;
            else { missing.push(t); missingIdx.push(i); }
          });

          var fresh = null;
          if (missing.length) {
            var res = await translateBatchViaBackground(missing, settings);
            if (!res.ok) {
              // یک بار دیگر، فقط همان دسته
              res = await translateBatchViaBackground(missing, settings);
            }
            if (res.ok) fresh = res.translations;
          }

          if (myRun !== runId) return; // لغو شده؛ نتیجه را دور بریز

          if (missing.length && !fresh) {
            failed += missing.length;
          } else if (fresh) {
            missing.forEach(function (t, k) {
              cache[hashText(t)] = fresh[k];
            });
            cacheDirty = true;
          }

          batch.forEach(function (entry, i) {
            var tr = cached[i] || (fresh ? fresh[missingIdx.indexOf(i)] : null);
            if (tr) applyTranslation(entry, tr);
          });

          if (!firstApplied && translatedNodes.length) {
            firstApplied = true;
            enableRtl();
            if (document.title && document.title.trim()) {
              originalTitle = document.title;
              var titleRes = await translateBatchViaBackground([document.title.trim()], settings);
              if (myRun === runId && titleRes.ok && titleRes.translations[0]) {
                document.title = titleRes.translations[0];
              }
            }
          }

          done++;
          updateProgress(done, batches.length);
        }
      })());
    }
    await Promise.all(workers);
    if (myRun !== runId) return; // لغو شده بود

    saveCache();
    removeProgressBar();
    if (translatedNodes.length) {
      state = 'translated';
      startObserver(settings);
      showToast(
        failed > 0
          ? 'ترجمه تمام شد؛ ' + failed + ' جمله ترجمه نشد. یک بار دیگر بزن تا همان‌ها را بگیرد.'
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
    var nodes = collectTextNodes(document.body).filter(function (node) {
      return !translatedNodes.some(function (item) { return item.node === node; });
    });
    if (!nodes.length) return;
    var built = buildBatches(nodes);
    for (var i = 0; i < built.batches.length; i++) {
      var batch = built.batches[i];
      var texts = batch.map(function (e) { return e.text; });
      var res = await translateBatchViaBackground(texts, settings);
      if (res.ok) {
        batch.forEach(function (entry, k) {
          cache[hashText(entry.text)] = res.translations[k];
          applyTranslation(entry, res.translations[k]);
        });
        cacheDirty = true;
      }
    }
    saveCache();
  }

  // ---------- پیام از پاپ‌آپ ----------

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.type === 'mirza-translate') {
      translatePage();
      sendResponse({ ok: true, state: state });
    } else if (msg.type === 'mirza-status') {
      sendResponse({ ok: true, state: state });
    }
    return false;
  });
})();
