// popup.js — پاپ‌آپ مترجم میرزا

var btn = document.getElementById('translateBtn');
var statusEl = document.getElementById('status');
var errorEl = document.getElementById('error');
var tabId = null;

try {
  document.getElementById('verBadge').textContent = 'نسخه ' + chrome.runtime.getManifest().version;
} catch (_e) {}

function setStatus(state) {
  statusEl.classList.toggle('done', state === 'translated');
  if (state === 'translated') {
    statusEl.textContent = 'این صفحه ترجمه شده است.';
    btn.textContent = 'برگشت به انگلیسی';
  } else if (state === 'translating') {
    statusEl.textContent = 'در حال ترجمه… پیشرفت را پایین صفحه ببین.';
    btn.textContent = 'در حال ترجمه…';
    btn.disabled = true;
  } else {
    statusEl.textContent = 'این صفحه هنوز ترجمه نشده است.';
    btn.textContent = 'ترجمه صفحه';
  }
}

function showError(text) {
  errorEl.style.display = 'block';
  errorEl.textContent = text;
}

function showCannotTranslate() {
  statusEl.textContent = 'در این صفحه نمی‌شود ترجمه کرد (مثل صفحه داخلی کروم).';
  btn.disabled = true;
}

// اسکریپت ترجمه فقط موقع باز شدن صفحه تزریق می‌شود؛ پس زبانه‌ای که پیش از
// نصب یا به‌روزرسانی افزونه باز شده، اسکریپت را ندارد. این‌جا خودش تزریق می‌شود
// و دیگر لازم نیست صفحه را تازه کنی.
function injectContentScript(cb) {
  chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] }, function () {
    if (chrome.runtime.lastError) { cb(false); return; }
    chrome.scripting.insertCSS({ target: { tabId: tabId }, files: ['translator.css'] }, function () {
      cb(!chrome.runtime.lastError);
    });
  });
}

// پرچم محافظ دو بار تزریق را پاک می‌کند تا اسکریپت تازه جای کهنه بنشیند.
function clearStaleFlag(cb) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function () { try { delete window.__mirzaTranslatorLoaded; } catch (_e) {} }
  }, function () { cb(!chrome.runtime.lastError); });
}

// وضعیت را می‌پرسد؛ اگر اسکریپت نیست یا کهنه است، تزریق می‌کند و دوباره می‌پرسد.
// done: تابع اختیاری که true/false می‌گیرد.
function queryStatus(done, staleRetried) {
  chrome.tabs.sendMessage(tabId, { type: 'mirza-status' }, function (res) {
    if (chrome.runtime.lastError || !res) {
      injectContentScript(function (ok) {
        if (!ok) { showCannotTranslate(); if (done) done(false); return; }
        queryStatusAfterInject(done, staleRetried);
      });
      return;
    }
    if (res.error === 'stale') { handleStale(done, staleRetried); return; }
    setStatus(res.state);
    if (done) done(true);
  });
}

function queryStatusAfterInject(done, staleRetried) {
  chrome.tabs.sendMessage(tabId, { type: 'mirza-status' }, function (res) {
    if (chrome.runtime.lastError || !res) { showCannotTranslate(); if (done) done(false); return; }
    if (res.error === 'stale') { handleStale(done, staleRetried); return; }
    setStatus(res.state);
    if (done) done(true);
  });
}

function handleStale(done, staleRetried) {
  if (staleRetried) {
    statusEl.textContent = 'افزونه به‌روز شد؛ این صفحه را یک بار تازه کن.';
    btn.disabled = true;
    if (done) done(false);
    return;
  }
  clearStaleFlag(function () {
    injectContentScript(function (ok) {
      if (!ok) { showCannotTranslate(); if (done) done(false); return; }
      queryStatusAfterInject(done, true);
    });
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  if (!tabs || !tabs[0]) { showError('زبانه‌ای پیدا نشد.'); return; }
  tabId = tabs[0].id;
  queryStatus();

  btn.addEventListener('click', function () {
    errorEl.style.display = 'none';
    // پیش از فرستادن دستور، مطمئن می‌شویم اسکریپت در زبانه هست
    queryStatus(function (ok) {
      if (!ok) { btn.disabled = false; return; }
      chrome.tabs.sendMessage(tabId, { type: 'mirza-translate' }, function (res) {
        if (chrome.runtime.lastError || !res) {
          showError('به صفحه وصل نشدم؛ صفحه را تازه کن و دوباره بزن.');
          return;
        }
        setTimeout(function () {
          chrome.tabs.sendMessage(tabId, { type: 'mirza-status' }, function (r) {
            if (r) {
              if (r.error && r.state === 'idle') showError(r.error);
              else setStatus(r.state);
            }
            btn.disabled = false;
          });
        }, 600);
      });
      btn.disabled = true;
      btn.textContent = '…';
    });
  });
});

document.getElementById('optionsLink').addEventListener('click', function () {
  chrome.runtime.openOptionsPage();
});

// ---------- به‌روزرسانی ----------
var updateStatusEl = document.getElementById('updateStatus');
var updateBtn = document.getElementById('updateBtn');
var pendingUpdate = null;

function checkForUpdate() {
  chrome.runtime.sendMessage({ type: 'mirza-check-update' }, function (res) {
    if (!res || !res.ok) {
      updateStatusEl.textContent = 'به‌روزرسانی را بررسی نکردم (' + ((res && res.errorText) || 'وصل نشد') + ').';
      return;
    }
    if (!res.updateAvailable) {
      updateStatusEl.textContent = 'افزونه به‌روز است (نسخه ' + res.current + ').';
      return;
    }
    pendingUpdate = res;
    updateStatusEl.textContent = 'نسخه ' + res.latest + ' آمده است' + (res.notes ? '؛ ' + res.notes : '') + '.';
    updateBtn.style.display = 'block';
    updateBtn.textContent = 'به‌روزرسانی به نسخه ' + res.latest;
  });
}

updateBtn.addEventListener('click', function () {
  if (!pendingUpdate) return;
  updateBtn.disabled = true;
  updateBtn.textContent = 'در حال به‌روزرسانی…';
  updateStatusEl.textContent = 'فایل‌های تازه در حال گرفتن هستند؛ پنجره را نبند.';
  chrome.runtime.sendMessage(
    {
      type: 'mirza-do-update',
      base: 'https://raw.githubusercontent.com/masoudroot/mirza-translator/main',
      files: pendingUpdate.files
    },
    function (res) {
      if (res && res.ok) {
        updateStatusEl.textContent = 'نصب شد؛ افزونه یک لحظه دیگر با نسخه تازه بالا می‌آید.';
        setTimeout(function () { chrome.runtime.reload(); }, 900);
      } else {
        updateBtn.disabled = false;
        updateBtn.textContent = 'به‌روزرسانی به نسخه ' + pendingUpdate.latest;
        updateStatusEl.textContent = 'به‌روزرسانی نشد: ' + ((res && res.errorText) || 'خطای نامشخص');
      }
    }
  );
});

checkForUpdate();

// ---------- تغییر مدل از همین‌جا ----------
// فهرست مدل‌ها در حافظه کش می‌شود (mirza_models)؛ اگر برای همین درگاه نیست،
// دکمه به‌روزرسانی آن را از درگاه می‌گیرد.
var currentSettings = null;
var cachedModels = null;
var modelToggleBtn = document.getElementById('modelToggle');
var modelBodyEl = document.getElementById('modelListBody');
var modelSearchEl = document.getElementById('modelSearch');
var modelItemsEl = document.getElementById('modelItems');
var modelEmptyEl = document.getElementById('modelEmpty');
var modelMsgEl = document.getElementById('modelMsg');
var currentModelEl = document.getElementById('currentModel');

function modelMsg(text) { modelMsgEl.textContent = text || ''; }

function renderPopupModels() {
  var q = (modelSearchEl.value || '').trim().toLowerCase();
  var selected = currentSettings && currentSettings.model ? currentSettings.model : '';
  modelItemsEl.innerHTML = '';
  var shown = 0;
  var list = (cachedModels && cachedModels.models) || [];
  list.forEach(function (id) {
    if (q && id.toLowerCase().indexOf(q) === -1) return;
    var li = document.createElement('li');
    li.textContent = id;
    if (id === selected) li.classList.add('selected');
    li.addEventListener('click', function () {
      if (!currentSettings) return;
      currentSettings.model = id;
      chrome.storage.local.set({ mirza_settings: currentSettings }, function () {
        currentModelEl.textContent = id;
        renderPopupModels();
        modelMsg('مدل عوض شد: ' + id);
      });
    });
    modelItemsEl.appendChild(li);
    shown++;
  });
  modelEmptyEl.hidden = shown > 0 || !list.length;
}

function loadModelSection() {
  chrome.storage.local.get(['mirza_settings', 'mirza_models'], function (r) {
    currentSettings = r.mirza_settings || null;
    currentModelEl.textContent = (currentSettings && currentSettings.model) || 'تنظیم نشده';
    cachedModels = r.mirza_models || null;
    if (cachedModels && cachedModels.provider === (currentSettings && currentSettings.provider)) {
      renderPopupModels();
    } else {
      modelMsg('فهرست مدل‌ها برای این درگاه نیست؛ «به‌روزرسانی فهرست» را بزن.');
    }
  });
}

modelToggleBtn.addEventListener('click', function () {
  var open = modelBodyEl.hidden;
  modelBodyEl.hidden = !open;
  modelToggleBtn.textContent = open ? 'پنهان کردن' : 'تغییر مدل';
  if (open) modelSearchEl.focus();
});

modelSearchEl.addEventListener('input', renderPopupModels);

document.getElementById('modelRefresh').addEventListener('click', function () {
  if (!currentSettings || !currentSettings.baseUrl) {
    modelMsg('اول در تنظیمات آدرس و کلید را کامل کن.');
    return;
  }
  modelMsg('در حال گرفتن فهرست مدل‌ها…');
  chrome.runtime.sendMessage(
    { type: 'mirza-fetch-models', baseUrl: currentSettings.baseUrl, apiKey: currentSettings.apiKey, provider: currentSettings.provider },
    function (res) {
      if (!res || !res.ok) {
        modelMsg('فهرست را نگرفتم: ' + ((res && res.errorText) || 'وصل نشد'));
        return;
      }
      cachedModels = { provider: currentSettings.provider, models: res.models };
      renderPopupModels();
      modelMsg(res.models.length + ' مدل گرفتم.');
    }
  );
});

loadModelSection();
