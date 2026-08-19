// Keel EZ Estimate - Options Page Script

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

// ── Auto Update folder setup ─────────────────────────────────────────────

async function refreshUpdateFolderStatus() {
  const statusBox = $('update-folder-status');
  const reauthBtn = $('btn-reauth-update-folder');
  const clearBtn = $('btn-clear-update-folder');
  const M = window.EZUpdateManager;

  if (!M) { statusBox.textContent = 'Update system failed to load on this page.'; return; }

  const handle = await M.getDirectoryHandle();
  if (!handle) {
    statusBox.innerHTML = '<strong>No folder set yet.</strong> Click "Set update folder" and choose the folder your unpacked extension lives in.';
    reauthBtn.classList.add('hidden');
    clearBtn.classList.add('hidden');
    return;
  }

  const permission = await M.queryFolderPermission(handle);
  if (permission === 'granted') {
    try {
      await M.verifyFolderExists(handle);
      statusBox.innerHTML = '<strong>✓ Update folder set and ready</strong> — "' + (handle.name || 'folder') + '". Updates will be written here.';
      reauthBtn.classList.add('hidden');
    } catch (e) {
      statusBox.innerHTML = '<strong>⚠ Folder not found.</strong> "' + (handle.name || 'folder') + '" may have been renamed, moved, or deleted. Click "Set update folder" to pick it again.';
      reauthBtn.classList.add('hidden');
    }
  } else {
    statusBox.innerHTML = '<strong>⚠ Permission needs to be re-granted</strong> for "' + (handle.name || 'folder') + '".';
    reauthBtn.classList.remove('hidden');
  }
  clearBtn.classList.remove('hidden');
}

$('btn-set-update-folder').addEventListener('click', async () => {
  const M = window.EZUpdateManager;
  if (!M) { showStatus('Update system failed to load.', 'error'); return; }
  if (!window.showDirectoryPicker) {
    showStatus('Your Chrome version does not support folder access (File System Access API).', 'error');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await M.setDirectoryHandle(handle);
    showStatus('✓ Update folder set to "' + handle.name + '"', 'success');
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user cancelled the picker
    showStatus('Could not set update folder: ' + e.message, 'error');
  }
  refreshUpdateFolderStatus();
});

$('btn-reauth-update-folder').addEventListener('click', async () => {
  const M = window.EZUpdateManager;
  const handle = await M.getDirectoryHandle();
  if (!handle) { showStatus('No folder set yet — click "Set update folder" first.', 'error'); return; }
  try {
    const result = await M.requestFolderPermission(handle);
    if (result === 'granted') {
      showStatus('✓ Permission re-granted', 'success');
    } else {
      showStatus('Permission was not granted.', 'error');
    }
  } catch (e) {
    showStatus('Could not request permission: ' + e.message, 'error');
  }
  refreshUpdateFolderStatus();
});

$('btn-clear-update-folder').addEventListener('click', async () => {
  const M = window.EZUpdateManager;
  await M.clearDirectoryHandle();
  showStatus('Update folder forgotten — updates disabled until you set one again.', 'info');
  refreshUpdateFolderStatus();
});

refreshUpdateFolderStatus();

// External links
$('link-openai').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: 'https://platform.openai.com/api-keys' }); });
$('link-anthropic').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: 'https://console.anthropic.com/settings/keys' }); });
$('link-gemini').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: 'https://aistudio.google.com/app/apikey' }); });
$('link-setup').addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: 'https://console.cloud.google.com/' }); });
