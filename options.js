// Duke Estimating - Options Page Script

function $(id) { return document.getElementById(id); }

function showStatus(msg, type = 'info') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
  if (type !== 'error') setTimeout(() => el.classList.add('hidden'), 5000);
}

// Show redirect URI
$('redirect-uri').textContent = chrome.identity.getRedirectURL();

// Load saved settings
chrome.storage.local.get(['clientId','sheetId','sheetName','openaiKey','claudeKey','geminiKey'], (cfg) => {
  if (cfg.clientId)  $('clientId').value  = cfg.clientId;
  if (cfg.openaiKey) $('openaiKey').value  = cfg.openaiKey;
  if (cfg.claudeKey) $('claudeKey').value  = cfg.claudeKey;
  if (cfg.geminiKey) $('geminiKey').value  = cfg.geminiKey;
  $('sheetId').value   = cfg.sheetId   || '1iO37IiTagtu4OGEZSHA5C62tPRc5HOKMpq0UcsUI9ig';
  $('sheetName').value = cfg.sheetName || '2026 CUSTOM PLAN';
});

// Save
$('btn-save').addEventListener('click', () => {
  const clientId  = $('clientId').value.trim();
  const sheetId   = $('sheetId').value.trim();
  const sheetName = $('sheetName').value.trim();
  const openaiKey = $('openaiKey').value.trim();
  const claudeKey = $('claudeKey').value.trim();
  const geminiKey = $('geminiKey').value.trim();

  if (!sheetId) { showStatus('Sheet ID is required', 'error'); return; }

  chrome.storage.local.set({ clientId, sheetId, sheetName, openaiKey, claudeKey, geminiKey }, () => {
    showStatus('✓ Settings saved!', 'success');
  });
});

// Sign out of Google
$('btn-signout').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'SIGN_OUT' }, () => showStatus('Signed out of Google', 'info'));
});

// Test Sheets connection
$('btn-test-sheets').addEventListener('click', () => {
  showStatus('Testing Sheets connection…', 'info');
  chrome.runtime.sendMessage({ action: 'GET_TAB_DATA', tab: 'fixed-costs' }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      showStatus(`Sheets error: ${res?.error || chrome.runtime.lastError?.message}`, 'error');
    } else {
      showStatus(`✓ Sheets connected — ${res.rows?.length || 0} rows read`, 'success');
    }
  });
});

// Test OpenAI key — send a tiny text-only request
$('btn-test-openai').addEventListener('click', async () => {
  const key = $('openaiKey').value.trim();
  if (!key) { showStatus('Enter an OpenAI key first', 'error'); return; }
  showStatus('Testing OpenAI key…', 'info');
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] })
    });
    if (res.ok) {
      showStatus('✓ OpenAI key is valid — GPT-4o is ready!', 'success');
    } else {
      const err = await res.json();
      showStatus(`OpenAI error: ${err.error?.message || res.status}`, 'error');
    }
  } catch (e) {
    showStatus(`Network error: ${e.message}`, 'error');
  }
});

// Test Claude key
$('btn-test-claude').addEventListener('click', async () => {
  const key = $('claudeKey').value.trim();
  if (!key) { showStatus('Enter a Claude key first', 'error'); return; }
  showStatus('Testing Claude key…', 'info');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] })
    });
    if (res.ok) {
      showStatus('✓ Claude key is valid — Claude 3.5 Sonnet is ready!', 'success');
    } else {
      const err = await res.json();
      showStatus(`Claude error: ${err.error?.message || res.status}`, 'error');
    }
  } catch (e) {
    showStatus(`Network error: ${e.message}`, 'error');
  }
});

// Test Gemini key
$('btn-test-gemini').addEventListener('click', async () => {
  const key = $('geminiKey').value.trim();
  if (!key) { showStatus('Enter a Gemini key first', 'error'); return; }
  showStatus('Testing Gemini key…', 'info');
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Hi' }] }] })
    });
    if (res.ok) {
      showStatus('✓ Gemini key is valid — Gemini 2.0 Flash is ready!', 'success');
    } else {
      const err = await res.json();
      showStatus(`Gemini error: ${err.error?.message || res.status}`, 'error');
    }
  } catch (e) {
    showStatus(`Network error: ${e.message}`, 'error');
  }
});

// External links
$('link-openai').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: 'https://platform.openai.com/api-keys' }); });
$('link-anthropic').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: 'https://console.anthropic.com/settings/keys' }); });
$('link-gemini').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: 'https://aistudio.google.com/app/apikey' }); });
$('link-setup').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: 'https://console.cloud.google.com/' }); });
