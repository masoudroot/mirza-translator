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
  'Rules:',
  '- Write fluent, natural, simple Persian, the way a real Persian speaker would say it. No translationese, no bureaucratic words.',
  '- Keep proper nouns (person names, brand names, product names) in their original form.',
  '- Keep numbers, dates and URLs exactly as they are.',
  '- Do not add explanations, notes or extra sentences.',
  '- Return ONLY a JSON object: {"translations": ["...", "..."]} with exactly one translation per input string, in the same order.'
].join('\n');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'mirza-api-translate') {
    translateBatch(msg.texts, msg.settings).then(sendResponse);
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
    fetchModels(msg.baseUrl, msg.apiKey).then(sendResponse);
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

async function postChat(settings, messages, useJsonMode) {
  const base = cleanBaseUrl(settings.baseUrl);
  const body = {
    model: settings.model,
    messages,
    temperature: 0.3
  };
  if (useJsonMode) body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
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
    if (!res.ok) {
      const detail = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      return { ok: false, error: detail, status: res.status };
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    return { ok: true, content: String(content || '') };
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
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

async function translateBatch(texts, settings) {
  if (!settings || !settings.apiKey) {
    return { ok: false, error: 'no_api_key' };
  }
  if (!settings.baseUrl || !settings.model) {
    return { ok: false, error: 'no_settings' };
  }
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ texts }) }
  ];

  // تلاش اول با حالت JSON؛ اگر درگاه قبول نکرد، بدون آن دوباره می‌زنیم.
  let res = await postChat(settings, messages, true);
  if (!res.ok && res.status === 400) {
    res = await postChat(settings, messages, false);
  }
  if (!res.ok) return { ok: false, error: res.error || 'request_failed' };

  const translations = parseTranslations(res.content, texts.length);
  if (!translations) return { ok: false, error: 'bad_response' };
  return { ok: true, translations };
}

async function fetchModels(baseUrl, apiKey) {
  const base = cleanBaseUrl(baseUrl);
  if (!base) return { ok: false, error: 'no_base_url' };
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
      return { ok: false, error: detail, status: res.status };
    }
    const list = (data && Array.isArray(data.data) ? data.data : [])
      .map((m) => m && m.id)
      .filter(Boolean)
      .sort();
    return { ok: true, models: list };
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message || err) };
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
    const res = await fetch(UPDATE_BASE + '/version.json?t=' + Date.now(), { signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, current };
    const data = await res.json();
    if (!data || !data.version || !Array.isArray(data.files)) {
      return { ok: false, error: 'bad_version_file', current };
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
    return { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message || err), current };
  } finally {
    clearTimeout(timer);
  }
}

function sendNative(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage('com.mirza.translator', msg, (res) => {
        if (chrome.runtime.lastError) {
          return resolve({ ok: false, error: chrome.runtime.lastError.message || 'native_host_error' });
        }
        resolve(res || { ok: false, error: 'no_response' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

async function doUpdate(base, files) {
  if (!base || !Array.isArray(files) || !files.length) {
    return { ok: false, error: 'no_update_info' };
  }
  return sendNative({ action: 'update', base, files });
}

async function pingHost() {
  return sendNative({ action: 'ping' });
}

async function testConnection(settings) {
  if (!settings || !settings.apiKey) return { ok: false, error: 'no_api_key' };
  const res = await postChat(
    settings,
    [
      { role: 'system', content: 'Reply with exactly this Persian word: سلام' },
      { role: 'user', content: 'Hello' }
    ],
    false
  );
  if (!res.ok) return { ok: false, error: res.error || 'request_failed' };
  return { ok: true, reply: res.content.trim().slice(0, 80) };
}
