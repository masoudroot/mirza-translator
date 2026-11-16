// options.js — تنظیمات مترجم میرزا

var PRESETS = {
  dotdotagent: { baseUrl: 'https://api.samp.team/v1', model: 'deepseek-v4.1-flash' },
  reformboss: { baseUrl: 'https://api.reformboss.com/v1', model: 'deepseek-v4.1-flash-1017' },
  custom: { baseUrl: '', model: '' }
};

var baseUrlEl = document.getElementById('baseUrl');
var apiKeyEl = document.getElementById('apiKey');
var modelEl = document.getElementById('modelInput');
var modelListEl = document.getElementById('modelList');
var fetchBtn = document.getElementById('fetchBtn');
var saveBtn = document.getElementById('saveBtn');
var testBtn = document.getElementById('testBtn');
var messageEl = document.getElementById('message');
var presetBtns = Array.prototype.slice.call(document.querySelectorAll('.preset'));

var currentProvider = 'dotdotagent';

function showMessage(text, ok) {
  messageEl.textContent = text;
  messageEl.className = ok ? 'ok' : 'err';
}

function markPreset(provider) {
  currentProvider = provider;
  presetBtns.forEach(function (b) {
    b.classList.toggle('active', b.dataset.provider === provider);
  });
}

function readForm() {
  return {
    provider: currentProvider,
    baseUrl: baseUrlEl.value.trim().replace(/\/+$/, ''),
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value.trim()
  };
}

function fillForm(settings) {
  if (!settings) return;
  markPreset(settings.provider || 'dotdotagent');
  baseUrlEl.value = settings.baseUrl || '';
  apiKeyEl.value = settings.apiKey || '';
  modelEl.value = settings.model || '';
}

function loadSettings() {
  chrome.storage.local.get('mirza_settings', function (r) {
    fillForm(r.mirza_settings);
    // اگر کلید و آدرس از قبل هست، مدل‌ها را خودکار بگیر تا فهرست آماده باشد
    var s = r.mirza_settings;
    if (s && s.baseUrl && s.apiKey) fetchModels(true);
  });
}

presetBtns.forEach(function (b) {
  b.addEventListener('click', function () {
    var preset = PRESETS[b.dataset.provider];
    markPreset(b.dataset.provider);
    if (preset.baseUrl) baseUrlEl.value = preset.baseUrl;
    if (preset.model && !modelEl.value) modelEl.value = preset.model;
    if (b.dataset.provider === 'custom') baseUrlEl.focus();
  });
});

function fetchModels(quiet) {
  var baseUrl = baseUrlEl.value.trim();
  var apiKey = apiKeyEl.value.trim();
  if (!baseUrl) {
    if (!quiet) showMessage('اول آدرس پایه را بنویس.', false);
    return;
  }
  fetchBtn.disabled = true;
  fetchBtn.textContent = 'در حال گرفتن…';
  chrome.runtime.sendMessage(
    { type: 'mirza-fetch-models', baseUrl: baseUrl, apiKey: apiKey },
    function (res) {
      fetchBtn.disabled = false;
      fetchBtn.textContent = 'گرفتن مدل‌ها';
      if (!res || !res.ok) {
        var err = (res && res.error) || 'وصل نشد';
        if (!quiet) showMessage('مدل‌ها را نگرفتم: ' + err + ' — نام مدل را دستی بنویس.', false);
        return;
      }
      modelListEl.innerHTML = '';
      res.models.forEach(function (id) {
        var opt = document.createElement('option');
        opt.value = id;
        modelListEl.appendChild(opt);
      });
      var saved = modelEl.value.trim();
      if (saved && res.models.indexOf(saved) === -1) {
        // مدل ذخیره‌شده در فهرست نیست؛ سر جایش می‌ماند، فقط خبر می‌دهیم
        if (!quiet) showMessage(res.models.length + ' مدل گرفتم؛ ولی مدل ذخیره‌شده در فهرست نبود و سر جایش ماند.', true);
      } else {
        if (!modelEl.value.trim() && res.models.length) modelEl.value = res.models[0];
        if (!quiet) showMessage(res.models.length + ' مدل گرفتم؛ یکی را انتخاب کن و ذخیره بزن.', true);
      }
    }
  );
}

fetchBtn.addEventListener('click', function () { fetchModels(false); });

saveBtn.addEventListener('click', function () {
  var settings = readForm();
  if (!settings.baseUrl || settings.baseUrl.indexOf('http') !== 0) {
    showMessage('آدرس پایه درست نیست؛ باید با http شروع شود.', false);
    return;
  }
  if (!settings.apiKey) {
    showMessage('کلید API را بگذار.', false);
    return;
  }
  if (!settings.model) {
    showMessage('مدل را انتخاب کن یا نامش را بنویس.', false);
    return;
  }
  chrome.storage.local.set({ mirza_settings: settings }, function () {
    showMessage('ذخیره شد. از این به بعد ترجمه با مدل «' + settings.model + '» انجام می‌شود.', true);
  });
});

testBtn.addEventListener('click', function () {
  var settings = readForm();
  if (!settings.baseUrl || !settings.apiKey || !settings.model) {
    showMessage('اول آدرس، کلید و مدل را کامل کن.', false);
    return;
  }
  testBtn.disabled = true;
  testBtn.textContent = 'در حال آزمایش…';
  showMessage('', true);
  chrome.runtime.sendMessage({ type: 'mirza-test', settings: settings }, function (res) {
    testBtn.disabled = false;
    testBtn.textContent = 'آزمایش اتصال';
    if (res && res.ok) {
      showMessage('وصل شد. جواب مدل: ' + res.reply, true);
    } else {
      showMessage('وصل نشد: ' + ((res && res.error) || 'خطای نامشخص'), false);
    }
  });
});

loadSettings();

// ---------- آزمایش میزبان به‌روزرسان ----------
var hostTestBtn = document.getElementById('hostTestBtn');
var hostMessageEl = document.getElementById('hostMessage');
hostTestBtn.addEventListener('click', function () {
  hostTestBtn.disabled = true;
  hostTestBtn.textContent = 'در حال آزمایش…';
  hostMessageEl.textContent = '';
  chrome.runtime.sendMessage({ type: 'mirza-ping-host' }, function (res) {
    hostTestBtn.disabled = false;
    hostTestBtn.textContent = 'آزمایش میزبان';
    if (res && res.ok) {
      hostMessageEl.style.color = '#104C46';
      hostMessageEl.textContent = 'میزبان وصل است و پوشه افزونه را می‌بیند. دکمه به‌روزرسانی آماده است.';
    } else {
      hostMessageEl.style.color = '#a33';
      hostMessageEl.textContent = 'میزبان وصل نیست. یک بار install-host.bat را از پوشه افزونه اجرا کن و دوباره آزمایش بزن.';
    }
  });
});
