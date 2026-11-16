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
            if (r && !r.error) setStatus(r.state);
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
      updateStatusEl.textContent = 'به‌روزرسانی را بررسی نکردم (' + ((res && res.error) || 'وصل نشد') + ').';
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
        var err = (res && res.error) || 'خطای نامشخص';
        if (/not found|could not|native host/i.test(err)) {
          updateStatusEl.textContent = 'میزبان به‌روزرسان نصب نیست. یک بار فایل install-host.bat را از پوشه افزونه اجرا کن، بعد دوباره بزن.';
        } else {
          updateStatusEl.textContent = 'به‌روزرسانی نشد: ' + err;
        }
      }
    }
  );
});

checkForUpdate();
