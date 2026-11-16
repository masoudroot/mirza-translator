// background.js — service worker مترجم میرزا
// فقط یک کار می‌کند: حرف زدن با API ترجمه. هیچ‌وقت به DOM صفحه دست نمی‌زند.

const DEFAULT_SETTINGS = {
  provider: 'dotdotagent',
  baseUrl: 'https://api.samp.team/v1',
  model: 'deepseek-v4.1-flash',
  apiKey: ''
};

const SYSTEM_PROMPT = [
  'You translate web page text from English to Persian.',
  'Translate like a native Persian writer, not word by word: natural, fluent, clear Persian that reads as if it was written in Persian first. Keep the meaning exact. Keep the tone of the original: formal stays formal, casual stays casual. Short strings stay short; headings stay punchy and short.',
  'Rules:',
  '- Keep proper nouns (person names, brand names, product names) in their original form.',
  '- Keep numbers, dates and URLs exactly as they are.',
  '- Do not add explanations, notes or extra sentences.',
  '- Return ONLY a JSON object: {"translations": ["...", "..."]} with exactly one translation per input string, in the same order.'
].join('\n');

const BEGINNER_PROMPT = [
  'You rewrite Persian web page text into much simpler Persian for a complete beginner, as if a caring Iranian writer wrote it for someone reading Persian for the first time.',
  'The result must be visibly simpler than the input: shorter sentences, everyday words, spoken-friendly tone. A reader must be able to see at a glance that this text is simpler than an ordinary translation.',
  'Rules:',
  '- Break every sentence longer than about 15 words into two or more short sentences, one idea each.',
  '- Replace every formal, literary, or technical word with the plain word people use in daily speech. Explain an abstract idea in plain words inside the sentence instead of naming it with a hard term.',
  '- Write like friendly spoken Persian, not formal written Persian.',
  '- Keep the meaning exact; never add new facts, examples, or sentences.',
  '- Keep proper nouns (person names, brand names, product names) in their original form.',
  '- Keep numbers, dates and URLs exactly as they are.',
  '- Short strings (a few words) may stay unchanged. Every longer string must come back reworded.',
  '- Return ONLY a JSON object: {"translations": ["...", "..."]} with exactly one translation per input string, in the same order.'
].join('\n');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'mirza-api-translate') {
    translateBatch(msg.texts, msg.settings, msg.mode, msg.model).then(sendResponse);
    return true; // async
  }
  if (msg.type === 'mirza-test') {
    testConnection(msg.settings).then(sendResponse);
    return true;
  }
  if (msg.type === 'mirza-check-update') {
    checkUpdate().then(sendResponse);
    return true;
  }
  if (msg.type === 'mirza-do-update') {
    doUpdate(msg.base, msg.files).then(sendResponse);
    return true;
  }
  if (msg.type === 'mirza-ping-host') {
    pingHost().then(sendResponse);
    return true;
  }
  if (msg.type === 'mirza-fetch-models') {
    fetchModels(msg.baseUrl, msg.apiKey, msg.provider).then(sendResponse);
    return true;
  }
  if (msg.type === 'mirza-get-models') {
    chrome.storage.local.get('mirza_models', (r) => {
      sendResponse(r.mirza_models || null);
    });
    return true;
  }
  if (msg.type === 'mirza-open-options') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (msg.type === 'mirza-get-settings') {
    chrome.storage.local.get('mirza_settings', (r) => {
      sendResponse(Object.assign({}, DEFAULT_SETTINGS, r.mirza_settings || {}));
    });
    return true;
  }
  return false;
});

function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// ---------- پیام خطای شفاف ----------
// هر خطا یک کد ماشینی و یک متن فارسی روشن دارد تا کاربر بداند دقیقاً چه شد
// و چه کار کند. خطای شبکه معمولاً یعنی اینترنت یا پروکسی؛ افزونه از پروکسی
// خود کروم استفاده می‌کند، پس اگر v2rayNG داری باید در حالت سراسری (Global) باشد.
function describeError(code, status, detail) {
  switch (code) {
    case 'network':
      return 'به درگاه وصل نشد. اگر پروکسی (v2rayNG) داری، مطمئن شو روشن است و در حالت سراسری (Global)؛ اگر تازه روشنش کردی، یک بار صفحه را تازه کن.';
    case 'timeout':
      return 'درگاه در ۶۰ ثانیه جواب نداد. دوباره بزن؛ اگر ادامه داشت، مدل دیگری را امتحان کن.';
    case 'unauthorized':
      return 'کلید API درست نیست؛ کلید را در تنظیمات بررسی کن.';
    case 'forbidden':
      return 'درگاه اجازه نداد (403)؛ شاید این کلید به این مدل دسترسی ندارد.';
    case 'not_found':
      return 'مدل یا آدرس پیدا نشد (404)؛ آدرس پایه و نام مدل را بررسی کن.';
    case 'rate_limited':
      return 'درگاه شلوغ است (429)؛ چند ثانیه صبر کن و دوباره بزن.';
    case 'bad_request':
      return 'درگاه درخواست را قبول نکرد (400)؛ مدل دیگری را امتحان کن.';
    case 'model_unavailable':
      return 'مدل «' + (detail || '') + '» الان در این درگاه در دسترس نیست؛ از فهرست مدل‌ها یکی دیگر را انتخاب کن.';
    case 'bad_response':
      return 'مدل جواب درست و کامل نداد؛ دوباره بزن.';
    case 'no_api_key':
      return 'کلید API را در تنظیمات بگذار.';
    case 'no_settings':
      return 'تنظیمات ناقص است؛ آدرس پایه و مدل را کامل کن.';
    case 'no_base_url':
      return 'آدرس پایه را بنویس.';
    case 'update_host':
      return 'میزبان به‌روزرسان نصب نیست. یک بار فایل install-host.bat را از پوشه افزونه اجرا کن، بعد دوباره بزن.';
    case 'bad_version_file':
      return 'فایل نسخه تازه خراب است؛ بعداً دوباره بزن.';
    case 'no_update_info':
      return 'اطلاعات به‌روزرسانی ناقص است؛ دوباره بررسی کن.';
    default:
      return (detail ? 'خطا: ' + detail : 'خطای نامشخص؛ دوباره بزن.') + (status ? ' (HTTP ' + status + ')' : '');
  }
}

function httpCode(status) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 400) return 'bad_request';
  return 'http_error';
}

// خطای کشنده: با این خطا هیچ دسته‌ای درست نمی‌شود؛ کل ترجمه همان‌جا می‌ایستد.
var FATAL_ERRORS = { model_unavailable: true, unauthorized: true, not_found: true };

function failResult(code, status, detail) {
  return { ok: false, error: code, errorText: describeError(code, status, detail), status: status || 0, fatal: !!FATAL_ERRORS[code] };
}

// ---------- جایگزینی خودکار مدل ----------
// اگر مدلِ انتخاب‌شده جواب ندهد، پس‌زمینه خودش سراغ مدل بعدی می‌رود و بقیه
// کار را با آن پیش می‌برد؛ کاربر لازم نیست دوباره دکمه بزند.
// نقشه سلامت (mirza_model_health): هر مدل کی آخرین بار سالم جواب داد و کی
// خراب شد؛ مدل خراب تا یک ساعت دیگر نامزد نمی‌شود تا هر بار همان تلاش
// بیهوده تکرار نشود. لایه تندِ حافظه کارگر هم همین را نگه می‌دارد تا دسته‌های
// موازیِ یک اجرا، خرابیِ تازه را بی‌درنگ ببینند.

var MODEL_HEALTH_KEY = 'mirza_model_health';
var MODEL_MODELS_KEY = 'mirza_models';
var SICK_TTL_MS = 3600000; // یک ساعت
var MAX_MODEL_ATTEMPTS = 3; // مدل انتخاب‌شده + حداکثر دو جایگزین در هر دسته
var modelHealthMemory = {};

// خطاهایی که با عوض کردن مدل درست می‌شوند؛ بقیه (کلید اشتباه، شبکه) با
// مدل دیگر هم همان می‌مانند و جایگزینی بیهوده است.
var FALLBACK_ERRORS = { model_unavailable: true, not_found: true, timeout: true, rate_limited: true, bad_response: true };

function storageGet(keys) {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get(keys, function (r) { resolve(r || {}); });
    } catch (_e) { resolve({}); }
  });
}

function recordModelOutcome(model, ok) {
  if (!model) return;
  var now = Date.now();
  var rec = modelHealthMemory[model] || {};
  if (ok) rec.ok = now; else rec.fail = now;
  modelHealthMemory[model] = rec;
  // ذخیره ماندگار؛ خواندن بعدیِ نامزدها از همین‌جا می‌آید. کل نقشه درون‌حافظه
  // هر بار ادغام می‌شود تا نوشتن‌های هم‌زمانِ دسته‌های موازی هم را نبلعند.
  try {
    storageGet([MODEL_HEALTH_KEY]).then(function (r) {
      var map = (r && r[MODEL_HEALTH_KEY]) || {};
      Object.keys(modelHealthMemory).forEach(function (m) {
        var mem = modelHealthMemory[m];
        var entry = map[m] || {};
        entry.ok = Math.max(entry.ok || 0, mem.ok || 0);
        entry.fail = Math.max(entry.fail || 0, mem.fail || 0);
        map[m] = entry;
      });
      try { chrome.storage.local.set({ mirza_model_health: map }); } catch (_e) {}
    });
  } catch (_e) {}
}

function isSick(rec, now) {
  return !!rec && !!rec.fail && (!rec.ok || rec.fail > rec.ok) && (now - rec.fail) < SICK_TTL_MS;
}

// ترتیب نامزدها: اول مدل انتخاب‌شده اگر سالم است؛ بعد مدل‌هایی که تازگی سالم
// جواب داده‌اند (تازه‌ترین اول)؛ بعد بقیه مدل‌های سالم، به ترتیب فهرست درگاه.
// فهرست مدل‌ها از کش خوانده می‌شود (پاپ‌آپ و تنظیمات همان را تازه می‌کنند)؛
// پس‌زمینه برای ترجمه به شبکه نمی‌رود تا دسته سالم، درخواست اضافه نخورد.
// اگر هیچ مدل سالمی نماند، همان مدل انتخاب‌شده را می‌زنیم؛ بهتر از هیچ است.
async function orderedCandidates(settings, preferredModel) {
  var now = Date.now();
  var stored = await storageGet([MODEL_MODELS_KEY, MODEL_HEALTH_KEY]);
  var cached = stored[MODEL_MODELS_KEY] || {};
  var list = [];
  if (Array.isArray(cached.models) && cleanBaseUrl(cached.baseUrl || '') === cleanBaseUrl(settings.baseUrl)) {
    list = cached.models;
  }
  var health = Object.assign({}, stored[MODEL_HEALTH_KEY] || {});
  Object.keys(modelHealthMemory).forEach(function (m) {
    var mem = modelHealthMemory[m];
    var old = health[m] || {};
    health[m] = {
      ok: Math.max(old.ok || 0, mem.ok || 0),
      fail: Math.max(old.fail || 0, mem.fail || 0)
    };
  });
  var seen = {};
  var ordered = [];
  function push(m) { if (m && !seen[m]) { seen[m] = true; ordered.push(m); } }
  if (!isSick(health[preferredModel], now)) push(preferredModel);
  var proven = list.filter(function (m) { return health[m] && health[m].ok && !isSick(health[m], now); });
  proven.sort(function (a, b) { return (health[b].ok || 0) - (health[a].ok || 0); });
  proven.forEach(push);
  list.forEach(function (m) { if (!isSick(health[m], now)) push(m); });
  if (!ordered.length) push(preferredModel);
  return ordered;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postChat(settings, messages, useJsonMode, plain) {
  const base = cleanBaseUrl(settings.baseUrl);
  const body = {
    model: settings.model,
    messages,
    temperature: 0.3
  };
  // مدل‌های فکرکننده (مثل deepseek) بی‌این دو، همه توکن‌ها را صرف فکر
  // می‌کنند و جواب خالی برمی‌گردانند (finish_reason: length). تلاش کم برای
  // فکر + جای کافی برای جواب، بیشتر دسته‌ها را همان بار اول سالم می‌کند.
  // plain یعنی بدون این دو و بدون حالت JSON، برای درگاهی که آن‌ها را نمی‌پذیرد.
  if (!plain) {
    body.max_tokens = 8192;
    body.reasoning_effort = 'low';
  }
  if (useJsonMode) body.response_format = { type: 'json_object' };

  // درگاه شلوغ (429) موقتی است؛ همان درخواست را با فاصله دوباره می‌زنیم.
  // فاصله‌ها تصادفی‌اند تا تلاش‌های هم‌زمان روی هم نیفتند و طوفان نسازند.
  // پیام بالادستی می‌گوید «چند ثانیه صبر کن»، پس فاصله‌ها چند ثانیه‌ای‌اند.
  // بدون این صبر، تلاش دوباره و نصف کردن فقط بار درگاه را بیشتر می‌کند.
  const retryDelays = [3000, 8000];
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + settings.apiKey
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429 && attempt < retryDelays.length) {
        await sleepMs(retryDelays[attempt] * (0.5 + Math.random()));
        continue;
      }
      if (!res.ok) {
        const detail = (data && data.error && data.error.message) || ('HTTP ' + res.status);
        if (res.status === 400 && /unavailable|not found|does not exist|doesn't exist|no such model|недоступн/i.test(detail)) {
          return failResult('model_unavailable', res.status, settings.model || '');
        }
        return failResult(httpCode(res.status), res.status, detail);
      }
      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
      return { ok: true, content: String(content || '') };
    } catch (err) {
      if (err && err.name === 'AbortError') return failResult('timeout');
      return failResult('network', 0, String(err && err.message || err));
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseTranslations(content, expectedCount) {
  if (!content) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch (_e) {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(content.slice(start, end + 1)); } catch (_e2) { parsed = null; }
    }
  }
  if (parsed && Array.isArray(parsed.translations) && parsed.translations.length === expectedCount) {
    return parsed.translations.map((t) => String(t));
  }
  if (parsed && Array.isArray(parsed.translations) && parsed.translations.length > 0) {
    return null; // تعداد نخورد؛ امن‌تر است که کل دسته را ناموفق بدانیم تا جمله‌ها جابه‌جا نشوند
  }
  return null;
}

async function translateBatch(texts, settings, mode, preferredModel) {
  if (!settings || !settings.apiKey) {
    return failResult('no_api_key');
  }
  if (!settings.baseUrl || !settings.model) {
    return failResult('no_settings');
  }
  var preferred = preferredModel || settings.model;
  var candidates = await orderedCandidates(settings, preferred);
  var lastFail = null;
  var tried = 0;
  for (var i = 0; i < candidates.length && i < MAX_MODEL_ATTEMPTS; i++) {
    var model = candidates[i];
    tried++;
    var res = await attemptBatch(texts, settings, mode, model);
    if (res.ok) {
      recordModelOutcome(model, true);
      return { ok: true, translations: res.translations, model: model };
    }
    recordModelOutcome(model, false);
    lastFail = res;
    if (!FALLBACK_ERRORS[res.error]) break; // با مدل دیگر هم درست نمی‌شود
  }
  // همه نامزدها خراب شدند، یا خطا از آن‌هایی است که جایگزینی ندارد؛
  // fallbackExhausted یعنی پس‌زمینه همه مدل‌ها را زده و چیزی نمانده.
  return Object.assign({}, lastFail, { model: preferred, fallbackExhausted: tried > 1 });
}

// یک تلاش با یک مدل مشخص: حالت JSON اول، بعد ساده، بعد یک بار تعمیرِ تعداد.
async function attemptBatch(texts, settings, mode, model) {
  var s = Object.assign({}, settings, { model: model });
  // حالت مبتدی: همان متن انگلیسی دوباره خوانده می‌شود و فارسی ساده برای
  // یک مبتدی نوشته می‌شود؛ پرامپت در تلاش دوباره و تعمیر هم همان می‌ماند.
  const prompt = mode === 'beginner' ? BEGINNER_PROMPT : SYSTEM_PROMPT;
  const messages = [
    { role: 'system', content: prompt },
    { role: 'user', content: JSON.stringify({ texts }) }
  ];

  // تلاش اول با حالت JSON؛ اگر درگاه قبول نکرد، ساده و بدون پارامتر اضافه دوباره می‌زنیم.
  // اگر خطا «مدل در دسترس نیست» بود، تلاش دوباره بیهوده است.
  let res = await postChat(s, messages, true);
  if (!res.ok && res.status === 400 && res.error !== 'model_unavailable') {
    res = await postChat(s, messages, false, true);
  }
  if (!res.ok) return res;

  let translations = parseTranslations(res.content, texts.length);
  if (!translations) {
    // تعداد ترجمه‌ها نخورد؛ یک بار با یادآوری دقیق دوباره می‌خواهیم.
    // این یک درخواست اضافه است، ولی از فرستادن تک‌تک رشته‌ها خیلی سریع‌تر است.
    const repair = await postChat(s, [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify({ texts }) },
      { role: 'assistant', content: res.content },
      { role: 'user', content: 'Your reply had the wrong number of translations. Reply again with exactly ' + texts.length + ' translations, one per input string, in the same order, as {"translations": [...]}.' }
    ], true);
    if (repair.ok) translations = parseTranslations(repair.content, texts.length);
  }
  if (!translations) return failResult('bad_response');
  return { ok: true, translations };
}

async function fetchModels(baseUrl, apiKey, provider) {
  const base = cleanBaseUrl(baseUrl);
  if (!base) return failResult('no_base_url');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(base + '/models', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + (apiKey || ''),
        Accept: 'application/json'
      },
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      return failResult(httpCode(res.status), res.status, detail);
    }
    const list = (data && Array.isArray(data.data) ? data.data : [])
      .map((m) => m && m.id)
      .filter(Boolean)
      .sort();
    // فهرست کش می‌شود تا پاپ‌آپ هم بدون رفتن به تنظیمات آن را نشان بدهد
    try {
      chrome.storage.local.set({ mirza_models: { provider: provider || '', baseUrl: base, models: list, fetchedAt: Date.now() } });
    } catch (_e) {}
    return { ok: true, models: list };
  } catch (err) {
    if (err && err.name === 'AbortError') return failResult('timeout');
    return failResult('network', 0, String(err && err.message || err));
  } finally {
    clearTimeout(timer);
  }
}

// ---------- به‌روزرسانی خودکار ----------
// مرجع نسخه تازه: ریپوی گیت‌هاب mirza-translator. هر بار که میرزا نسخه تازه‌ای
// می‌سازد، version.json و فایل‌ها آنجا می‌روند و دکمه به‌روزرسانی در افزونه
// همان‌ها را می‌گیرد. فایل‌ها فقط از raw.githubusercontent.com می‌آیند.

const UPDATE_BASE = 'https://raw.githubusercontent.com/masoudroot/mirza-translator/main';

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function checkUpdate() {
  const current = chrome.runtime.getManifest().version;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    // کش را دور می‌زنیم: نسخه روی CDN گیت‌هاب چند دقیقه کهنه می‌ماند و
    // بررسیِ تازه نباید جواب کهنه بگیرد.
    const res = await fetch(UPDATE_BASE + '/version.json?t=' + Date.now(), { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return Object.assign(failResult(httpCode(res.status), res.status), { current });
    const data = await res.json();
    if (!data || !data.version || !Array.isArray(data.files)) {
      return Object.assign(failResult('bad_version_file'), { current });
    }
    return {
      ok: true,
      current,
      latest: data.version,
      files: data.files,
      notes: data.notes || '',
      updateAvailable: compareVersions(data.version, current) > 0
    };
  } catch (err) {
    const f = err && err.name === 'AbortError' ? failResult('timeout') : failResult('network', 0, String(err && err.message || err));
    return Object.assign(f, { current });
  } finally {
    clearTimeout(timer);
  }
}

function sendNative(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage('com.mirza.translator', msg, (res) => {
        if (chrome.runtime.lastError) {
          return resolve(failResult('update_host', 0, chrome.runtime.lastError.message || ''));
        }
        resolve(res || failResult('update_host'));
      });
    } catch (e) {
      resolve(failResult('update_host', 0, String(e && e.message || e)));
    }
  });
}

async function doUpdate(base, files) {
  if (!base || !Array.isArray(files) || !files.length) {
    return failResult('no_update_info');
  }
  return sendNative({ action: 'update', base, files });
}

async function pingHost() {
  return sendNative({ action: 'ping' });
}

async function testConnection(settings) {
  if (!settings || !settings.apiKey) return failResult('no_api_key');
  const messages = [
    { role: 'system', content: 'Reply with exactly this Persian word: سلام' },
    { role: 'user', content: 'Hello' }
  ];
  let res = await postChat(settings, messages, false);
  if (!res.ok && res.status === 400) res = await postChat(settings, messages, false, true);
  if (!res.ok) return res;
  return { ok: true, reply: res.content.trim().slice(0, 80) };
}
