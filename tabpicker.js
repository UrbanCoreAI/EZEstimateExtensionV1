// ═══════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════
var pendingItems = [];
var pendingCustomItems = [];
var pendingSiteOptions = [];
var pendingClientPreview = false;
var pendingSlowConnection = false;
var pendingNotifyEstimator = false; // webpage-only feature — see background.js's OPEN_ESTIMATE_TAB_PICKER handler
var pendingNotifyItemNames = [];
var _writeTabId = null;

document.addEventListener('DOMContentLoaded', init);

function stopWrite() {
  if (_writeTabId) {
    chrome.scripting.executeScript({
      target: { tabId: _writeTabId },
      func: function() { window.__keelWriteStop = true; }
    }).catch(function(){});
  }
}

async function init() {
  var data = await chrome.storage.session.get(['pendingEstimateItems','pendingCustomItems','pendingSiteOptions','pendingClientPreview','pendingSlowConnection','pendingNotifyEstimator','pendingNotifyItemNames']);
  pendingItems = data.pendingEstimateItems || [];
  pendingCustomItems = data.pendingCustomItems || [];
  pendingSiteOptions = data.pendingSiteOptions || [];
  pendingClientPreview = !!data.pendingClientPreview;
  pendingSlowConnection = !!data.pendingSlowConnection;
  pendingNotifyEstimator = !!data.pendingNotifyEstimator;
  pendingNotifyItemNames = data.pendingNotifyItemNames || [];

  if (pendingClientPreview) {
    document.querySelector('.hdr-title').textContent = 'Start Prelim - Budget Client Preview';
    document.getElementById('item-count').textContent = 'Select a BuilderTrend Estimate tab';
    var cpWarning = document.getElementById('cp-warning');
    if (cpWarning) cpWarning.classList.remove('hidden');
  } else {
    document.getElementById('item-count').textContent =
      pendingItems.length + ' item' + (pendingItems.length === 1 ? '' : 's') + ' ready to write';
  }
  document.getElementById('btn-refresh').addEventListener('click', loadTabs);
  document.getElementById('btn-back').addEventListener('click', showPicker);
  document.getElementById('btn-close').addEventListener('click', function () { window.close(); });
  document.getElementById('btn-stop-write').addEventListener('click', stopWrite);
  window.addEventListener('unload', stopWrite);
  await loadTabs();
}

function isBuilderTrendTab(t) {
  return !!(t.url && /buildertrend\.net|squaretakeoff\.com/i.test(t.url));
}

// ═══════════════════════════════════════════════════════════
// Tab list (the "share a tab" style picker)
// ═══════════════════════════════════════════════════════════
async function loadTabs() {
  var listEl = document.getElementById('tab-list');
  listEl.innerHTML = '<div class="loading">Loading open tabs…</div>';

  var tabs = await chrome.tabs.query({});
  var visible = tabs.filter(function (t) { return t.url && /^https?:\/\//.test(t.url); });

  visible.sort(function (a, b) {
    var ra = isBuilderTrendTab(a) ? 0 : 1;
    var rb = isBuilderTrendTab(b) ? 0 : 1;
    return ra - rb;
  });

  if (!visible.length) {
    listEl.innerHTML = '<div class="empty">No open tabs found. Open your BuilderTrend Estimate tab, then click Refresh.</div>';
    return;
  }

  listEl.innerHTML = '';
  visible.forEach(function (t) {
    var recommended = isBuilderTrendTab(t);
    var row = document.createElement('div');
    row.className = 'tab-row' + (recommended ? ' recommended' : '');

    var favicon = document.createElement('img');
    favicon.className = 'favicon';
    favicon.src = t.favIconUrl || 'icons/icon16.png';
    favicon.addEventListener('error', function () { favicon.src = 'icons/icon16.png'; });

    var info = document.createElement('div');
    info.className = 'tab-info';

    var title = document.createElement('div');
    title.className = 'tab-title';
    title.textContent = t.title || '(untitled tab)';

    var url = document.createElement('div');
    url.className = 'tab-url';
    try { url.textContent = new URL(t.url).hostname; } catch (e) { url.textContent = t.url; }

    info.appendChild(title);
    info.appendChild(url);
    row.appendChild(favicon);
    row.appendChild(info);

    if (recommended) {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'BuilderTrend';
      row.appendChild(badge);
    }

    row.addEventListener('click', function () { selectTab(t); });
    listEl.appendChild(row);
  });
}

function showPicker() {
  document.getElementById('progress-view').classList.add('hidden');
  document.getElementById('picker-view').classList.remove('hidden');
  loadTabs();
}

// ═══════════════════════════════════════════════════════════
// Write-to-estimate — runs in the chosen tab
// ═══════════════════════════════════════════════════════════
async function selectTab(tab) {
  document.getElementById('picker-view').classList.add('hidden');
  document.getElementById('progress-view').classList.remove('hidden');

  // slowConnection (set via the panel's checkbox, or sent by the webpage)
  // doubles every wait time this file's own outer-scope delays use. The
  // injected in-page automation (writeEstimateInPage, selectTabForClientPreview's
  // executeScript calls) gets the same flag passed in separately, since each
  // runs in its own isolated page context and can't see this closure.
  var slowConnection = pendingSlowConnection;
  function scaled(ms) { return slowConnection ? ms * 2 : ms; }

  var titleEl  = document.getElementById('progress-title');
  var statusEl = document.getElementById('progress-status');
  var logEl    = document.getElementById('log');
  var pbcpBtn  = document.getElementById('btn-start-pbcp');

  titleEl.textContent = 'Writing to: ' + (tab.title || tab.url);
  statusEl.className = 'progress-status';
  statusEl.innerHTML = '<span class="spin"></span>Bringing tab into focus…';
  logEl.textContent = '';
  if (pbcpBtn) { pbcpBtn.classList.add('hidden'); pbcpBtn.onclick = null; }

  // Bring this log window to the front of all tabs/windows so the user
  // notices when the run finishes, whether it's this write or (for the
  // client-preview branch below) the Client Preview flow it kicks off.
  async function bringLogWindowToFront() {
    try {
      var thisWin = await chrome.windows.getCurrent();
      await chrome.windows.update(thisWin.id, { focused: true, drawAttention: true });
    } catch (_) {}
  }

  function log(msg) {
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  if (pendingClientPreview) {
    // Focus the tab BEFORE reloading it — reloading while backgrounded lets
    // Chrome throttle the reload (deprioritized rendering/timers), so the
    // page can still be mid-hydration by the time we act on it. Focusing
    // first guarantees the reload happens in the foreground.
    statusEl.innerHTML = '<span class="spin"></span>Bringing tab into focus…';
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise(function (r) { setTimeout(r, scaled(400)); });

    // Now reload the (foregrounded) tab up front so it starts from a clean
    // state — no resource-timing entries or React state left over from a
    // different job that may have been viewed earlier in this same tab.
    statusEl.innerHTML = '<span class="spin"></span>Reloading tab…';
    await chrome.tabs.reload(tab.id);
    await new Promise(function (resolve) {
      function checkStatus() {
        chrome.tabs.get(tab.id, function (t) {
          if (t && t.status === 'complete') { resolve(); } else { setTimeout(checkStatus, scaled(300)); }
        });
      }
      setTimeout(checkStatus, scaled(800));
    });
    await new Promise(function (r) { setTimeout(r, scaled(1500)); });
    await selectTabForClientPreview(tab, titleEl, statusEl, logEl, slowConnection);
    return;
  }

  var wroteSomething = false;
  var stopBtn = document.getElementById('btn-stop-write');
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise(function (r) { setTimeout(r, scaled(400)); });

    _writeTabId = tab.id;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function() { window.__keelWriteStop = false; }
    }).catch(function(){});
    if (stopBtn) stopBtn.classList.remove('hidden');

    statusEl.innerHTML = '<span class="spin"></span>Writing items to the estimate…';

    var result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: writeEstimateInPage,
      args: [pendingItems, pendingCustomItems, pendingSiteOptions, slowConnection, pendingNotifyEstimator, pendingNotifyItemNames]
    });

    var res2 = result && result[0] && result[0].result;
    if (res2 && res2.lines) {
      wroteSomething = true;
      res2.lines.forEach(function (l) { log(l); });
      if (res2.stopped) {
        statusEl.className = 'progress-status error';
        statusEl.textContent = 'Stopped — wrote ' + res2.ok + ' item(s) before stopping.';
      } else if (res2.fail) {
        statusEl.className = 'progress-status error';
        statusEl.textContent = 'Wrote ' + res2.ok + ' item(s) · ' + res2.fail + ' failed — see log above.';
      } else {
        log('✓ Wrote ' + res2.ok + ' item(s) — reordering groups…');
        statusEl.innerHTML = '<span class="spin"></span>Reordering estimate groups…';

        // Reorder estimate groups by calling BT's own internal React handler
        var reorderResult = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: async function () {
            var DESIRED = [
              'Base House Pricing',
              'Selection Allowances',
              'Site Allowances',
              'Custom Selection Allowances',
              'Preferred Lender Incentive'
            ];

            function norm(s) { return (s || '').trim().toLowerCase().replace(/\s*\(\d+\)\s*$/, ''); }

            // Walk React fiber up from a group row to find the component
            // that owns onUpdateProposalFormatItems and formatDataWithoutFiltering
            var row = document.querySelector('tr.categoryRow');
            if (!row) return { ok: false, error: 'no categoryRow found' };
            var fiberKey = Object.keys(row).find(function (k) { return k.startsWith('__reactFiber'); });
            if (!fiberKey) return { ok: false, error: 'no React fiber found' };

            var node = row[fiberKey];
            var targetNode = null;
            var depth = 0;
            while (node && depth < 200) {
              if (node.memoizedProps && node.memoizedProps.onUpdateProposalFormatItems) {
                targetNode = node;
                break;
              }
              node = node.return;
              depth++;
            }
            if (!targetNode) return { ok: false, error: 'onUpdateProposalFormatItems not found in fiber tree' };

            var groups = targetNode.memoizedProps.formatDataWithoutFiltering;
            if (!Array.isArray(groups) || !groups.length) return { ok: false, error: 'formatDataWithoutFiltering missing or empty' };

            // Pull DESIRED groups to front, keep rest in original relative order
            var ordered = [];
            var remaining = groups.slice();
            for (var d = 0; d < DESIRED.length; d++) {
              for (var g = 0; g < remaining.length; g++) {
                if (norm(remaining[g].title) === norm(DESIRED[d])) {
                  ordered.push(remaining.splice(g, 1)[0]);
                  break;
                }
              }
            }
            ordered = ordered.concat(remaining);

            // Update displayOrder to match new positions
            for (var i = 0; i < ordered.length; i++) {
              ordered[i] = Object.assign({}, ordered[i], { displayOrder: i });
            }

            // Call BT's own handler — it handles auth, API format, everything
            await targetNode.memoizedProps.onUpdateProposalFormatItems(ordered);

            return { ok: true };
          }
        });

        var rr = reorderResult && reorderResult[0] && reorderResult[0].result;
        if (rr && !rr.ok) {
          log('⚠ Reorder: ' + (rr.error || 'unknown error'));
          statusEl.className = 'progress-status success';
          statusEl.textContent = '✓ Wrote ' + res2.ok + ' item(s) — group reorder failed (see log).';
        } else {
          statusEl.className = 'progress-status success';
          statusEl.textContent = '✓ Wrote ' + res2.ok + ' item(s) and reordered groups successfully.';
        }
      }
    } else if (result && result[0] && result[0].error) {
      log('⚠ Script error: ' + result[0].error.message);
      statusEl.className = 'progress-status error';
      statusEl.textContent = 'Script error — see log above.';
    } else {
      statusEl.className = 'progress-status success';
      statusEl.textContent = 'Write to Estimate complete.';
    }
  } catch (e) {
    log('ERROR: ' + e.message);
    statusEl.className = 'progress-status error';
    statusEl.textContent = 'Failed: ' + e.message;
  } finally {
    if (stopBtn) stopBtn.classList.add('hidden');
    _writeTabId = null;
    await bringLogWindowToFront();
    if (wroteSomething && pbcpBtn) {
      pbcpBtn.classList.remove('hidden');
      pbcpBtn.onclick = function () { selectTabForClientPreview(tab, titleEl, statusEl, logEl, slowConnection); };
    }
  }
}

// Injected into the target tab via chrome.scripting.executeScript.
async function writeEstimateInPage(itemsList, customItemsList, siteOptionsList, slowConnection, notifyEstimator, notifyItemNames) {
  try {
    var _log = [];
    // Every wait in this function funnels through _delay — doubling it here
    // is enough to double retry-loop budgets too (same iteration count, each
    // iteration just takes twice as long), so no loop counts need to change.
    var _delay = function (ms) { return new Promise(function (r) { setTimeout(r, slowConnection ? ms * 2 : ms); }); };

    function reactSet(input, val) {
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(val));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Global markup percent (Supabase markup_settings, singleton row,
    // anon-readable) — fetched once per write, applied to every item
    // below via trySetMarkupPercent(). A failed fetch leaves markupPercent
    // undefined, which trySetMarkupPercent treats as "don't touch
    // BuilderTrend's default markup" rather than writing a guess.
    var markupPercent;
    try {
      var markupRes = await fetch('https://fujddlemswhbdqrhpekt.supabase.co/rest/v1/markup_settings?select=markup_percent&id=eq.1', {
        headers: {
          apikey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1amRkbGVtc3doYmRxcmhwZWt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMTYzODcsImV4cCI6MjA5OTg5MjM4N30.pR2IINeUB6RDAXBG6IDHrLc3diW8TNYYN1jAIEdXFm4'
        }
      });
      if (markupRes.ok) {
        var markupRows = await markupRes.json();
        if (markupRows.length) markupPercent = markupRows[0].markup_percent;
      }
      if (markupPercent === undefined) _log.push('⚠ Could not read markup_settings from Supabase — BuilderTrend\'s default markup will be left in place on every item');
      else _log.push('Markup percent from admin database: ' + markupPercent + '%');
    } catch (markupErr) {
      _log.push('⚠ markup_settings fetch failed (' + markupErr.message + ') — BuilderTrend\'s default markup will be left in place on every item');
    }

    function writeReactValue(el, val) {
      if (!el) return;
      el.focus();
      if (typeof el.select === 'function') el.select();
      try {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        nativeSetter.call(el, String(val));
      } catch (e) {
        el.value = String(val);
      }
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      try {
        var textEvent = document.createEvent('TextEvent');
        textEvent.initTextEvent('textInput', true, true, null, String(val));
        el.dispatchEvent(textEvent);
      } catch (e) {}
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, String(val));
      } catch (e) {}
      el.blur();
    }

    // Writes the global markup percent onto whichever item's edit form is
    // currently open — called right before each write function's own save
    // step, so it rides along with that same save rather than opening a
    // separate panel. Confirmed selector from a real captured OuterHTML:
    // input#markupValue / input[data-testid="Markup.markupPercent"] — this
    // was captured from the existing-item edit panel (editExistingItem/
    // setItemMarkupAndDescription's context), where fields use flat,
    // non-namespaced ids like "description" and "unitCost" do. The
    // new-item-creation forms (createLineItem/createSiteItem) namespace
    // most fields per-row (e.g. "formatItems[4].items[0].unitCost") but
    // description is flat there too, so this tries the same flat selector
    // there as a reasonable bet — NOT verified for those two forms
    // specifically. If it's not found, this logs a warning and leaves
    // BuilderTrend's own default markup in place rather than failing the
    // whole item.
    async function trySetMarkupPercent(markupPercent, contextLabel) {
      if (markupPercent === null || markupPercent === undefined || isNaN(parseFloat(markupPercent))) return false;
      var markupInput = null;
      for (var mi = 0; mi < 10; mi++) {
        markupInput = document.querySelector('input[data-testid="Markup.markupPercent"], input#markupValue');
        if (markupInput) break;
        await _delay(150);
      }
      if (!markupInput) {
        _log.push('⚠ ' + contextLabel + ': markup field not found — leaving BuilderTrend\'s default markup in place');
        return false;
      }

      // NOT writeReactValue()/execCommand — that inserts the whole string
      // in one shot, and this specific field (class "PercentageInput", its
      // own per-keystroke masking) turned out to mangle that into a 10x
      // value (30 became 300 in testing). setQty()'s character-by-character
      // typing simulation already handles Ant Design numeric inputs
      // correctly (proven for both the quantity and unit-cost fields), so
      // this reuses that exact same approach instead of guessing at a
      // second fix for the same class of masked-input problem.
      var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      markupInput.focus();
      await _delay(100);
      if (typeof markupInput.select === 'function') markupInput.select();
      markupInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, ctrlKey: true, bubbles: true }));
      await _delay(50);
      markupInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', keyCode: 46, bubbles: true }));
      nativeSetter.call(markupInput, '');
      markupInput.dispatchEvent(new Event('input', { bubbles: true }));
      await _delay(100);

      var valStr = String(Math.round(parseFloat(markupPercent) * 100) / 100);
      for (var ci = 0; ci < valStr.length; ci++) {
        var ch = valStr[ci];
        var code = ch.charCodeAt(0);
        markupInput.dispatchEvent(new KeyboardEvent('keydown', { key: ch, keyCode: code, bubbles: true }));
        markupInput.dispatchEvent(new KeyboardEvent('keypress', { key: ch, keyCode: code, bubbles: true }));
        nativeSetter.call(markupInput, valStr.slice(0, ci + 1));
        markupInput.dispatchEvent(new Event('input', { bubbles: true }));
        markupInput.dispatchEvent(new KeyboardEvent('keyup', { key: ch, keyCode: code, bubbles: true }));
        await _delay(20);
      }
      await _delay(200);
      return true;
    }

    function findWorksheetSearchBar() {
      var collapseBtn = Array.from(document.querySelectorAll('button')).find(function(b) {
        return (b.textContent || '').includes('Collapse all');
      });
      if (collapseBtn) {
        var el = collapseBtn;
        while (el && el !== document.body) {
          var inp = el.querySelector('input[role="combobox"].ant-select-selection-search-input');
          if (inp) return inp;
          el = el.parentElement;
        }
      }
      return document.getElementById('rc_select_17') || document.getElementById('rc_select_1') || null;
    }

    function waitForModalClose(maxWaitMs) {
      maxWaitMs = maxWaitMs || 2000;
      if (slowConnection) maxWaitMs *= 2;
      return new Promise(function (resolve) {
        var startWait = performance.now();
        var checkInterval = setInterval(function () {
          var modal = document.querySelector('.ant-modal-wrap, .ant-modal-root, [class*="modal"][class*="show"]');
          var elapsed = performance.now() - startWait;
          if (!modal || elapsed >= maxWaitMs) { clearInterval(checkInterval); resolve(elapsed); }
        }, 50);
      });
    }

    async function setQty(name, qty, isUnitCost) {
      var needle = name.toLowerCase();
      var words = needle.split(/\s+/).filter(Boolean);
      var startTime = performance.now();

      var si = null;
      for (var wi = 0; wi < 20; wi++) {
        si = document.getElementById('rc_select_17');
        if (!si) si = document.getElementById('rc_select_1');
        if (!si) {
          var collapseBtn = Array.from(document.querySelectorAll('button')).find(function (btn) {
            return btn.textContent && btn.textContent.includes('Collapse all');
          });
          if (collapseBtn) {
            var parent = collapseBtn.closest('[class*="header"], [class*="control"], div');
            if (parent) si = parent.querySelector('input[role="combobox"].ant-select-selection-search-input');
          }
        }
        if (!si) {
          var candidates = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input'));
          candidates = candidates.filter(function (el) {
            var id = el.id || '';
            return id && id.startsWith('rc_select_') && id !== 'rc_select_0' && id !== 'savedFilterDropdown' && !id.match(/^\d+$/);
          });
          si = candidates[0];
        }
        if (si) break;
        await _delay(100);
      }
      if (!si) { _log.push('✗ ' + name + ' — search bar not found'); return; }

      var container = si.closest('.ant-select-selector') || si.parentElement;
      if (container) { container.click(); await _delay(200); }
      si.focus();
      await _delay(100);

      var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(si, name);
      si.dispatchEvent(new Event('input', { bubbles: true }));
      si.dispatchEvent(new Event('change', { bubbles: true }));
      await _delay(500);

      var opts = document.querySelectorAll('.LineItemResult.LineItem');
      var clicked = false;
      for (var o = 0; o < opts.length; o++) {
        var optTxt = (opts[o].innerText || '').trim().toLowerCase();
        if (words.every(function (w) { return optTxt.includes(w); })) {
          opts[o].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          opts[o].dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          opts[o].click();
          clicked = true;
          break;
        }
      }
      if (!clicked) { _log.push('○ ' + name + ' — not in dropdown'); return; }

      function isInGroupHeader(node) {
        var ownCls = node.className || '';
        if (ownCls.includes('proposalFormatGroupCellTitle') || ownCls.includes('proposalFormatGroupCellTitleReadonly')) return true;
        var n = node.parentElement;
        while (n && n !== document.body) {
          var cc = n.className || '';
          if (cc.includes('WorksheetGroupCellActions') || cc.includes('proposalFormatGroupCell')) return true;
          n = n.parentElement;
        }
        return false;
      }

      function findValueDisplay() {
        var vds = document.querySelectorAll('.ValueDisplay');
        for (var v = 0; v < vds.length; v++) {
          if (!vds[v].offsetHeight || isInGroupHeader(vds[v])) continue;
          if ((vds[v].innerText || '').trim().toLowerCase() === needle) return vds[v];
        }
        for (var v2 = 0; v2 < vds.length; v2++) {
          if (!vds[v2].offsetHeight || isInGroupHeader(vds[v2])) continue;
          var t = (vds[v2].innerText || '').trim().toLowerCase();
          if (words.every(function (w) { return t.includes(w); })) return vds[v2];
        }
        return null;
      }

      var el = null;
      for (var attempt = 0; attempt < 15; attempt++) {
        el = findValueDisplay();
        if (el) break;
        await _delay(100);
      }
      if (!el) { _log.push('○ ' + name + ' — ValueDisplay not found'); return; }

      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      await _delay(300);
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
      await _delay(400);

      var qtyInput = null;
      if (isUnitCost) qtyInput = document.querySelector('input[data-testid="unitCost"], input#unitCost');
      if (!qtyInput) {
        qtyInput = document.querySelector('input[role="spinbutton"].ant-input-number-input')
          || document.querySelector('input[role="spinbutton"]')
          || document.querySelector('input.ant-input-number-input');
      }
      if (!qtyInput) { _log.push('○ ' + name + ' — qty input not found'); return; }

      qtyInput.focus();
      await _delay(150);
      qtyInput.select();
      qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, ctrlKey: true, bubbles: true }));
      await _delay(50);
      qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', keyCode: 46, bubbles: true }));
      reactSet(qtyInput, '');
      qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
      await _delay(100);

      var roundedQty = Math.round(qty * 100) / 100;
      var valStr = String(roundedQty);
      var setter2 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (var ci = 0; ci < valStr.length; ci++) {
        var ch = valStr[ci];
        var code = ch.charCodeAt(0);
        qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: ch, keyCode: code, bubbles: true }));
        qtyInput.dispatchEvent(new KeyboardEvent('keypress', { key: ch, keyCode: code, bubbles: true }));
        setter2.call(qtyInput, valStr.slice(0, ci + 1));
        qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
        qtyInput.dispatchEvent(new KeyboardEvent('keyup', { key: ch, keyCode: code, bubbles: true }));
        await _delay(20);
      }
      await _delay(200);

      var saveBtn = document.querySelector('[data-testid="saveButton"], #saveButton');
      if (!saveBtn) {
        for (var s = 0; s < 15; s++) {
          await _delay(100);
          saveBtn = document.querySelector('[data-testid="saveButton"], #saveButton');
          if (saveBtn) break;
        }
      }
      if (saveBtn) {
        saveBtn.click();
        await waitForModalClose(2000);
      } else {
        qtyInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        await _delay(500);
      }

      var totalTime = performance.now() - startTime;
      _log.push('✓ ' + name + ' → ' + qty + (isUnitCost ? ' (unit cost)' : ' (qty)') + ' (' + totalTime.toFixed(0) + 'ms)');
    }

    async function createLineItem(title, unitCost, description, markupPercent) {
      var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      var nsArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;

      // ── Step 1: Type in search bar, then click the <b>Custom Selection Allowances</b>
      // result — that's what scrolls the virtualized table to render the group row.
      var si = document.getElementById('rc_select_17') || document.getElementById('rc_select_1');
      if (!si) {
        var cands = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input'));
        si = cands.find(function(el){ var id=el.id||''; return id.startsWith('rc_select_') && id!=='rc_select_0'; });
      }
      if (si) {
        var cont = si.closest('.ant-select-selector') || si.parentElement;
        if (cont) { cont.click(); await _delay(200); }
        si.focus(); await _delay(100);
        ns.call(si, 'Custom Selection Allowances');
        si.dispatchEvent(new Event('input',{bubbles:true}));
        si.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(900);
        // Click the dropdown result — it appears as a <b> tag or a .LineItemResult
        // containing "Custom Selection Allowances". Clicking it scrolls the table to the group.
        var result = null;
        var bTags = document.querySelectorAll('b');
        for (var bi=0; bi<bTags.length; bi++) {
          if ((bTags[bi].textContent||'').trim().toLowerCase() === 'custom selection allowances') {
            result = bTags[bi]; break;
          }
        }
        // fallback: any visible dropdown item containing the text
        if (!result) {
          var items = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
          for (var ii=0; ii<items.length; ii++) {
            if ((items[ii].innerText||'').toLowerCase().includes('custom selection allowances')) {
              result = items[ii]; break;
            }
          }
        }
        if (result) {
          var clickTarget = result.closest('.LineItemResult') || result.closest('[class*="Result"]') || result;
          clickTarget.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          clickTarget.click();
          await _delay(700);
        }
      }

      // ── Step 2: Find the + button — group is now rendered in the DOM ─────────
      var plusBtn = null;
      for (var wi=0; wi<20; wi++) {
        var rows = document.querySelectorAll('.WorksheetGroupCellActions');
        for (var ri=0; ri<rows.length; ri++) {
          var titleEl = rows[ri].querySelector('.proposalFormatGroupCellTitle');
          if (titleEl && (titleEl.innerText||'').trim().toLowerCase() === 'custom selection allowances') {
            var candidate = rows[ri].querySelector('button.AddItemsDropdown');
            if (candidate) { plusBtn = candidate; break; }
          }
        }
        if (plusBtn) break;
        await _delay(150);
      }
      if (!plusBtn) { _log.push('✗ createLineItem: + button not found'); return; }
      plusBtn.scrollIntoView({ behavior:'instant', block:'center' });
      await _delay(300);

      // ── Step 3: Click + → Item ────────────────────────────────────────────
      var existingIds = new Set(Array.from(document.querySelectorAll('[data-testid*="itemTitle"]')).map(function(e){ return e.id; }));
      plusBtn.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      plusBtn.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      plusBtn.click();
      await _delay(600);

      // "Item" option in the dropdown that appears
      var itemOpt = null;
      for (var wi=0; wi<15; wi++) {
        var opts2 = document.querySelectorAll('.ant-dropdown-menu-title-content');
        for (var oi=0; oi<opts2.length; oi++) {
          if ((opts2[oi].textContent||'').trim() === 'Item') { itemOpt = opts2[oi]; break; }
        }
        if (itemOpt) break;
        await _delay(100);
      }
      if (!itemOpt) { _log.push('✗ createLineItem: Item option not found'); return; }
      itemOpt.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      itemOpt.click();
      await _delay(600);

      // Clear the search bar so the table fully re-renders and shows the new row
      if (si) {
        ns.call(si, '');
        si.dispatchEvent(new Event('input',{bubbles:true}));
        si.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(600);
      }

      // ── Step 4: Find the newly-added title input ──────────────────────────
      // The new row has class "editing" on the <tr> (confirmed from OuterHTML).
      // Find the title input inside any editing row, or fall back to any new itemTitle input.
      var newTitleEl = null;
      for (var a=0; a<30; a++) {
        // Primary: find input inside a tr.editing row
        var editingRow = document.querySelector('tr.editing');
        if (editingRow) {
          newTitleEl = editingRow.querySelector('input[id*="itemTitle"], [data-testid*="itemTitle"]');
          if (newTitleEl) break;
        }
        // Fallback: any itemTitle input not in our pre-existing set
        var allTitles = document.querySelectorAll('[data-testid*="itemTitle"], input[id*="itemTitle"]');
        for (var tt=0; tt<allTitles.length; tt++) {
          if (!existingIds.has(allTitles[tt].id)) { newTitleEl = allTitles[tt]; break; }
        }
        if (newTitleEl) break;
        await _delay(150);
      }
      if (!newTitleEl) { _log.push('✗ createLineItem: new title input not found'); return; }

      // Fill title
      newTitleEl.scrollIntoView({ behavior:'instant', block:'center' });
      writeReactValue(newTitleEl, title);
      await _delay(300);

      // ── Step 4.5: Description (optional) ──────────────────────────────────
      // Confirmed via real outerHTML: the description field is a flat,
      // non-namespaced <textarea id="description" name="description"
      // data-testid="description">, NOT scoped per-row like costCodeId/
      // parentId. Poll for it directly — no click-to-reveal needed, no
      // keyBase guessing, just wait for React to render it.
      if (description) {
        _log.push('  └ Writing description: "' + description + '"…');
        var descArea = null;
        for (var da = 0; da < 30; da++) {
          descArea = document.getElementById('description')
                  || document.querySelector('textarea[data-testid="description"]')
                  || document.querySelector('textarea[name="description"]');
          if (descArea) break;
          await _delay(150);
        }
        if (descArea) {
          descArea.scrollIntoView({ behavior:'instant', block:'center' });
          writeReactValue(descArea, description);
          await _delay(250);
          _log.push('  ✓ Description filled into textarea');
        } else {
          _log.push('⚠ createLineItem: description textarea not found — continuing');
        }
      }

      // ── Step 5: Cost code — type & pick "Custom Selection Allowances" ─────
      // keyBase e.g. "formatItems[4].items[0]"
      var keyBase = (newTitleEl.getAttribute('data-testid') || newTitleEl.id || '').replace(/\.itemTitle$/, '');
      var ccInput = document.querySelector('[id="' + keyBase + '.costCodeId"]');
      if (ccInput) {
        // click the select container first so the ant-select opens
        var ccWrap = ccInput.closest('.ant-select') || ccInput.parentElement;
        if (ccWrap) { ccWrap.click(); await _delay(300); }
        ccInput.focus(); await _delay(100);
        ns.call(ccInput, 'Custom Selection Allowances');
        ccInput.dispatchEvent(new Event('input',{bubbles:true}));
        ccInput.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(800);
        // Pick the dropdown option — matches OuterHTML: <div class="ant-select-item-option-content">Custom Selection Allowances</div>
        var ccOpt = null;
        var allCcOpts = document.querySelectorAll('.ant-select-item-option-content');
        for (var co=0; co<allCcOpts.length; co++) {
          if ((allCcOpts[co].textContent||'').trim() === 'Custom Selection Allowances') { ccOpt = allCcOpts[co]; break; }
        }
        if (ccOpt) {
          ccOpt.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          ccOpt.click();
          await _delay(400);
        } else {
          _log.push('⚠ createLineItem: cost code option not found — continuing');
        }
      }

      // ── Step 5.5: Parent group — set to "Custom Selection Allowances" ───────
      var pgInput = document.getElementById('parentId');
      if (pgInput) {
        var pgWrap = pgInput.closest('.ant-select') || pgInput.parentElement;
        if (pgWrap) { pgWrap.click(); await _delay(300); }
        pgInput.focus(); await _delay(100);
        ns.call(pgInput, 'Custom Selection Allowances');
        pgInput.dispatchEvent(new Event('input', { bubbles: true }));
        pgInput.dispatchEvent(new Event('change', { bubbles: true }));
        await _delay(600);
        var pgOpts = document.querySelectorAll('.ant-select-item-option-content');
        var pgOpt = null;
        for (var po = 0; po < pgOpts.length; po++) {
          if ((pgOpts[po].textContent || '').trim() === 'Custom Selection Allowances') {
            pgOpt = pgOpts[po]; break;
          }
        }
        if (pgOpt) {
          pgOpt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          pgOpt.click();
          await _delay(400);
        } else {
          _log.push('⚠ createLineItem: parent group option not found — continuing');
        }
      } else {
        _log.push('⚠ createLineItem: parentId input not found — continuing');
      }

      // ── Step 6: Unit cost ─────────────────────────────────────────────────
      // OuterHTML shows type="text", id & data-testid = keyBase + ".unitCost", value="0.0000"
      var ucInput = document.querySelector('input[data-testid="' + keyBase + '.unitCost"]')
                 || document.querySelector('input[id="' + keyBase + '.unitCost"]');
      if (ucInput) {
        ucInput.focus(); await _delay(150);
        if (typeof ucInput.select === 'function') ucInput.select();
        // clear existing "0.0000" then type the real value
        ns.call(ucInput, '');
        ucInput.dispatchEvent(new Event('input',{bubbles:true}));
        await _delay(50);
        var valStr = String(Math.round(parseFloat(unitCost) * 100) / 100);
        ns.call(ucInput, valStr);
        ucInput.dispatchEvent(new Event('input',{bubbles:true}));
        ucInput.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(200);
      } else {
        _log.push('⚠ createLineItem: unit cost input not found — continuing');
      }

      await trySetMarkupPercent(markupPercent, 'createLineItem');

      // ── Step 7: First save — click off to the left of the estimate to trigger
      // the dirty-tracking prompt ────────────────────────────────────────────
      var sideEl = document.querySelector('.ant-layout-sider, aside');
      var saveX = sideEl ? sideEl.getBoundingClientRect().right + 5 : 10;
      var saveY = window.innerHeight / 2;
      var saveTarget = document.elementFromPoint(saveX, saveY) || document.body;
      saveTarget.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:saveX,clientY:saveY}));
      await _delay(150);
      saveTarget.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:saveX,clientY:saveY}));
      await _delay(900);

      // ── Step 8: Second save — click the Save button on the dirty-tracking
      // popup. Without this, clicking off alone no longer persists the item —
      // the next createLineItem call's typing (search bar / cost code) can
      // then wipe out the still-unsaved row. Same pattern as editExistingItem
      // and editGroupPlaceHolder ─────────────────────────────────────────────
      var dirtySaveCreate = null;
      for (var dsc = 0; dsc < 15; dsc++) {
        dirtySaveCreate = document.querySelector('[data-testid="dirtyTrackingSave"]');
        if (dirtySaveCreate) break;
        await _delay(150);
      }
      if (dirtySaveCreate) {
        dirtySaveCreate.click();
        await _delay(800);
      }

      _log.push('✓ Created: ' + title + ' → $' + unitCost);
    }

    // Like createLineItem but scrolls to "Site Allowances" and sets a per-item parent group
    async function createSiteItem(title, parentGroup, unitCost, markupPercent) {
      var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

      // Step 1: Search "Site Allowances" to scroll table to that group — mirrors createLineItem exactly
      var si = findWorksheetSearchBar();
      if (si) {
        var cont = si.closest('.ant-select-selector') || si.parentElement;
        if (cont) { cont.click(); await _delay(200); }
        si.focus(); await _delay(100);
        ns.call(si, 'Site Allowances');
        si.dispatchEvent(new Event('input',{bubbles:true}));
        si.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(900);
        var siResult = null;
        var liItems = document.querySelectorAll('.LineItemResultTitle');
        for (var li=0; li<liItems.length; li++) {
          if ((liItems[li].textContent||'').trim().toLowerCase() === 'site allowances') { siResult = liItems[li]; break; }
        }
        if (siResult) {
          siResult.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          siResult.click();
          await _delay(700);
        } else {
          _log.push('⚠ createSiteItem: "Site Allowances" search result not found');
        }
      }

      // Step 2: Find + button — search is still active so the row is in view
      var plusBtn = null;
      for (var siat=0; siat<20; siat++) {
        var siRows = document.querySelectorAll('.WorksheetGroupCellActions');
        for (var siri=0; siri<siRows.length; siri++) {
          var siTitleEl = siRows[siri].querySelector('.proposalFormatGroupCellTitle');
          if (siTitleEl && (siTitleEl.innerText||'').trim().toLowerCase() === 'site allowances') {
            siRows[siri].dispatchEvent(new MouseEvent('mouseenter', {bubbles:true}));
            siRows[siri].dispatchEvent(new MouseEvent('mouseover', {bubbles:true}));
            // Only look WITHIN this exact row — no parentElement fallback (that finds wrong group's button)
            var siCandidate = siRows[siri].querySelector('button.AddItemsDropdown');
            if (siCandidate) { plusBtn = siCandidate; break; }
          }
        }
        if (plusBtn) break;
        await _delay(150);
      }
      if (!plusBtn) { _log.push('✗ createSiteItem: + button not found for Site Allowances'); return; }
      plusBtn.scrollIntoView({ behavior:'instant', block:'center' });
      await _delay(300);

      // Step 3: Click + → Item — same as createLineItem
      var siExistingIds = new Set(Array.from(document.querySelectorAll('[data-testid*="itemTitle"]')).map(function(e){ return e.id; }));
      plusBtn.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      plusBtn.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      plusBtn.click();
      await _delay(400);
      var itemOpt = null;
      for (var iat=0; iat<15; iat++) {
        var opts = document.querySelectorAll('.ant-dropdown-menu-title-content');
        for (var oi=0; oi<opts.length; oi++) {
          if ((opts[oi].textContent||'').trim() === 'Item') { itemOpt = opts[oi]; break; }
        }
        if (itemOpt) break;
        await _delay(100);
      }
      if (!itemOpt) { _log.push('✗ createSiteItem: Item option not found'); return; }
      itemOpt.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
      itemOpt.click();
      await _delay(600);

      // Step 4: Find title input — same approach as createLineItem
      // Clear search bar first so the table re-renders and shows the new editing row
      if (si) {
        ns.call(si, '');
        si.dispatchEvent(new Event('input',{bubbles:true}));
        si.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(600);
      }
      var newTitleEl = null;
      for (var tat=0; tat<30; tat++) {
        var editRow = document.querySelector('tr.editing');
        if (editRow) {
          newTitleEl = editRow.querySelector('input[id*="itemTitle"], [data-testid*="itemTitle"]');
          if (newTitleEl) break;
        }
        var allTitleInps = document.querySelectorAll('[data-testid*="itemTitle"], input[id*="itemTitle"]');
        for (var tt=0; tt<allTitleInps.length; tt++) {
          if (!siExistingIds.has(allTitleInps[tt].id)) { newTitleEl = allTitleInps[tt]; break; }
        }
        if (newTitleEl) break;
        await _delay(150);
      }
      if (!newTitleEl) { _log.push('✗ createSiteItem: title input not found'); return; }

      newTitleEl.scrollIntoView({ behavior:'instant', block:'center' });
      newTitleEl.focus(); await _delay(150);
      ns.call(newTitleEl, title);
      newTitleEl.dispatchEvent(new Event('input',{bubbles:true}));
      newTitleEl.dispatchEvent(new Event('change',{bubbles:true}));
      await _delay(300);

      // Step 5: Cost code — type the parent group name (e.g. "06 - Municipal Tap Fees") to
      // find the matching cost code, which also makes the parentId field appear in the form.
      var keyBase = (newTitleEl.getAttribute('data-testid') || newTitleEl.id || '').replace(/\.itemTitle$/, '');
      var ccInput = document.querySelector('[id="' + keyBase + '.costCodeId"]');
      if (ccInput) {
        var ccWrap = ccInput.closest('.ant-select') || ccInput.parentElement;
        if (ccWrap) { ccWrap.click(); await _delay(400); }
        ccInput.focus(); await _delay(200);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await _delay(100);
        document.execCommand('insertText', false, parentGroup);
        await _delay(1200);
        var ccOpt = null;
        var allCcOpts = document.querySelectorAll('.ant-select-item-option-content');
        for (var co=0; co<allCcOpts.length; co++) {
          if ((allCcOpts[co].textContent||'').trim() === parentGroup) { ccOpt = allCcOpts[co]; break; }
        }
        // Fallback: if parent group name isn't a cost code, use "09 - Lot Clearing/Site Prep"
        if (!ccOpt) {
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          await _delay(100);
          document.execCommand('insertText', false, '09 - Lot Clearing');
          await _delay(1200);
          allCcOpts = document.querySelectorAll('.ant-select-item-option-content');
          for (var co2=0; co2<allCcOpts.length; co2++) {
            if ((allCcOpts[co2].textContent||'').trim() === '09 - Lot Clearing/Site Prep') { ccOpt = allCcOpts[co2]; break; }
          }
        }
        if (ccOpt) {
          var ccOptParent = ccOpt.closest('.ant-select-item-option') || ccOpt.parentElement;
          ccOptParent.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
          await _delay(80);
          ccOptParent.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true}));
          ccOptParent.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
          await _delay(600);
          _log.push('✓ createSiteItem: cost code set');
        } else { _log.push('⚠ createSiteItem: cost code option not found — continuing'); }
      } else {
        _log.push('⚠ createSiteItem: cost code input not found (keyBase=' + keyBase + ')');
      }

      // Step 5.5: Parent group — wait for it to appear after cost code is set, then type & pick.
      // 20x200ms (4s) wasn't always enough — a real write timed out here and
      // the new site item silently fell back to BuilderTrend's own default
      // parent group ("Base House Pricing") instead of the intended one,
      // with no further recovery attempted below once that happens. 50x200ms
      // (10s) gives real headroom against the same kind of UI lag other
      // fields in this file already take 3-4+ seconds to settle from.
      var pgInput = null;
      for (var pgwait=0; pgwait<50; pgwait++) {
        pgInput = document.getElementById('parentId');
        if (pgInput) break;
        await _delay(200);
      }
      if (pgInput) {
        var pgWrap = pgInput.closest('.ant-select') || pgInput.parentElement;
        if (pgWrap) { pgWrap.click(); await _delay(400); }
        pgInput.focus(); await _delay(200);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await _delay(100);
        document.execCommand('insertText', false, parentGroup);
        await _delay(1000);
        var pgOpts = document.querySelectorAll('.ant-select-item-option-content');
        var pgOpt = null;
        for (var po=0; po<pgOpts.length; po++) {
          if ((pgOpts[po].textContent||'').trim() === parentGroup) { pgOpt = pgOpts[po]; break; }
        }
        if (pgOpt) {
          var pgOptParent = pgOpt.closest('.ant-select-item-option') || pgOpt.parentElement;
          pgOptParent.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
          await _delay(80);
          pgOptParent.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true}));
          pgOptParent.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
          await _delay(500);
          _log.push('✓ createSiteItem: parent group set to ' + parentGroup);
        } else { _log.push('⚠ createSiteItem: parent group "' + parentGroup + '" not found — continuing'); }
      } else {
        _log.push('⚠ createSiteItem: parentId input not found after waiting');
      }

      // Step 6: Unit cost — pulled from SITE OPTIONS sheet column C
      if (unitCost && parseFloat(unitCost) > 0) {
        var ucInput = document.querySelector('[data-testid="' + keyBase + '.unitCost"]')
                   || document.querySelector('[id="' + keyBase + '.unitCost"]');
        if (ucInput) {
          ucInput.focus(); await _delay(150);
          ucInput.select();
          ns.call(ucInput, '');
          ucInput.dispatchEvent(new Event('input',{bubbles:true}));
          await _delay(50);
          var siUcValStr = String(Math.round(parseFloat(unitCost) * 100) / 100);
          ns.call(ucInput, siUcValStr);
          ucInput.dispatchEvent(new Event('input',{bubbles:true}));
          ucInput.dispatchEvent(new Event('change',{bubbles:true}));
          await _delay(200);
        } else {
          _log.push('⚠ createSiteItem: unit cost input not found — continuing');
        }
      }

      await trySetMarkupPercent(markupPercent, 'createSiteItem');

      // Step 7: First save — click off to the sidebar to trigger the
      // dirty-tracking prompt
      var sideEl = document.querySelector('.ant-layout-sider, aside');
      var saveX = sideEl ? sideEl.getBoundingClientRect().right + 5 : 10;
      var saveY = window.innerHeight / 2;
      var saveTarget = document.elementFromPoint(saveX, saveY) || document.body;
      saveTarget.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:saveX,clientY:saveY}));
      await _delay(150);
      saveTarget.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:saveX,clientY:saveY}));
      await _delay(900);

      // Step 8: Second save — click the Save button on the dirty-tracking
      // popup, same as editExistingItem/editGroupPlaceHolder
      var dirtySaveSite = null;
      for (var dss = 0; dss < 15; dss++) {
        dirtySaveSite = document.querySelector('[data-testid="dirtyTrackingSave"]');
        if (dirtySaveSite) break;
        await _delay(150);
      }
      if (dirtySaveSite) {
        dirtySaveSite.click();
        await _delay(800);
      }

      _log.push('✓ Site item: ' + title + ' → ' + parentGroup + (unitCost ? ' → $' + unitCost : ''));
    }

    // Build lookup: existingLine name → siteOption (for items that edit in place)
    var editableItems = {};
    if (siteOptionsList) {
      for (var ei = 0; ei < siteOptionsList.length; ei++) {
        if (siteOptionsList[ei].existingLine) {
          editableItems[siteOptionsList[ei].existingLine] = siteOptionsList[ei];
        }
      }
    }

    async function editExistingItem(searchName, newTitle, unitCost, description, markupPercent) {
      var nsE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

      // Step 1: Search for item → click LineItemResult to open edit panel
      var siE = document.getElementById('rc_select_17') || document.getElementById('rc_select_1');
      if (!siE) {
        var candsE = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input'));
        siE = candsE.find(function(el){ var id=el.id||''; return id.startsWith('rc_select_') && id!=='rc_select_0'; });
      }
      if (siE) {
        var contE = siE.closest('.ant-select-selector') || siE.parentElement;
        if (contE) { contE.click(); await _delay(200); }
        siE.focus(); await _delay(100);
        nsE.call(siE, searchName);
        siE.dispatchEvent(new Event('input',{bubbles:true}));
        siE.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(900);
        var eResult = null;
        var eItems = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
        for (var eli=0; eli<eItems.length; eli++) {
          if ((eItems[eli].innerText||'').trim().toLowerCase() === searchName.toLowerCase()) { eResult = eItems[eli]; break; }
        }
        if (eResult) {
          eResult.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          eResult.click();
          await _delay(1000);
        }
        nsE.call(siE, '');
        siE.dispatchEvent(new Event('input',{bubbles:true}));
        siE.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(400);
      }

      // Step 2: Find the exact <b> tag in the table with matching text → click its row to open edit panel
      var targetRow = null;
      for (var tdi=0; tdi<20; tdi++) {
        var bTags = document.querySelectorAll('tr.proposalBaseLineItemContainerRow b');
        for (var tdi2=0; tdi2<bTags.length; tdi2++) {
          if ((bTags[tdi2].textContent||'').trim().toLowerCase() === searchName.toLowerCase()) {
            targetRow = bTags[tdi2].closest('tr.proposalBaseLineItemContainerRow');
            break;
          }
        }
        if (targetRow) break;
        await _delay(150);
      }
      if (!targetRow) { _log.push('⚠ editExistingItem: row not found for ' + searchName); return; }
      targetRow.click();
      await _delay(800);

      // Step 3: Click the title ValueDisplay in the side panel to open the title input
      var titleDisplay = null;
      for (var tdd=0; tdd<15; tdd++) {
        var tDisplays = document.querySelectorAll('.ValueDisplay[data-testid$=".itemTitle"]');
        for (var tdi3=0; tdi3<tDisplays.length; tdi3++) {
          if ((tDisplays[tdi3].textContent||'').trim().toLowerCase() === searchName.toLowerCase()) {
            titleDisplay = tDisplays[tdi3]; break;
          }
        }
        if (titleDisplay) break;
        await _delay(100);
      }
      if (titleDisplay) {
        titleDisplay.click();
        await _delay(400);
      } else { _log.push('⚠ editExistingItem: title ValueDisplay not found for ' + searchName); }

      var titleInp = null;
      for (var tii=0; tii<15; tii++) {
        titleInp = document.querySelector('input[data-testid="itemTitle"]');
        if (titleInp) break;
        await _delay(100);
      }
      if (titleInp) {
        titleInp.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, newTitle);
        await _delay(300);
      } else { _log.push('⚠ editExistingItem: title input did not appear for ' + searchName); }

      // Step 4: Click unit cost cell in same row → set cost
      var costCell = targetRow.querySelector('td[data-testid="cell-unitCost"] .ValueDisplay') ||
                     targetRow.querySelector('td[data-testid="cell-unitCost"]');
      if (costCell) {
        costCell.click();
        await _delay(400);
        var costInp = null;
        for (var cii=0; cii<15; cii++) {
          costInp = document.querySelector('input[data-testid="unitCost"]');
          if (costInp) break;
          await _delay(100);
        }
        if (costInp) {
          costInp.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          document.execCommand('insertText', false, String(unitCost));
          await _delay(300);
        } else { _log.push('⚠ editExistingItem: cost input did not appear for ' + searchName); }
      } else { _log.push('⚠ editExistingItem: cost cell not found for ' + searchName); }

      // Step 4.5: Allowance-tier description (Group B upgrade note). Same
      // flat, non-namespaced textarea createLineItem's Step 4.5 already
      // uses (confirmed via real outerHTML there — description is NOT
      // scoped per-row like costCodeId/parentId, unlike the title/cost
      // fields). Good tier passes no description, so this is skipped
      // entirely in that case.
      if (description) {
        _log.push('  └ Writing description: "' + description + '"…');
        var descAreaE = null;
        for (var daE = 0; daE < 30; daE++) {
          descAreaE = document.getElementById('description')
                   || document.querySelector('textarea[data-testid="description"]')
                   || document.querySelector('textarea[name="description"]');
          if (descAreaE) break;
          await _delay(150);
        }
        if (descAreaE) {
          descAreaE.scrollIntoView({ behavior: 'instant', block: 'center' });
          writeReactValue(descAreaE, description);
          await _delay(250);
          _log.push('  ✓ Description filled into textarea');
        } else {
          _log.push('⚠ editExistingItem: description textarea not found for ' + searchName);
        }
      }

      await trySetMarkupPercent(markupPercent, 'editExistingItem: ' + searchName);

      // Step 4: First save — coordinate click to trigger dirty-tracking prompt
      var sideEl = document.querySelector('.ant-layout-sider, aside');
      var saveX = sideEl ? sideEl.getBoundingClientRect().right + 5 : 10;
      var saveY = window.innerHeight / 2;
      var saveTarget = document.elementFromPoint(saveX, saveY) || document.body;
      saveTarget.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:saveX,clientY:saveY}));
      await _delay(150);
      saveTarget.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:saveX,clientY:saveY}));
      await _delay(900);

      // Step 5: Second save — click the Save button on the dirty-tracking popup
      var dirtySave = null;
      for (var ds=0; ds<15; ds++) {
        dirtySave = document.querySelector('[data-testid="dirtyTrackingSave"]');
        if (dirtySave) break;
        await _delay(150);
      }
      if (dirtySave) {
        dirtySave.click();
        await _delay(800);
      }

      _log.push('✓ editExistingItem: ' + searchName + ' → "' + newTitle + '" $' + unitCost);
    }

    // Group A allowance-tier description writer. setQty() (used for all
    // Group A quantity edits) only opens a small quantity spinbutton popup
    // with no description field, so a Better/Best upgrade note needs this
    // separate pass: search → find the row → click its title ValueDisplay
    // to open the side panel (same as editExistingItem Step 3, but the
    // title value itself is never touched/rewritten) → write the
    // description (flat #description textarea, same as createLineItem and
    // editExistingItem above) → save.
    //
    // ⚠ Unverified against a live BuilderTrend page: this runs immediately
    // after setQty() has already interacted with a different, smaller
    // popup on the same row — if descriptions don't land for Group A
    // items, that timing/interaction sequence is the first thing to check.
    // Opens an item's edit panel once and writes BOTH the global markup
    // percent (always, when provided) and an optional tier-upgrade
    // description in that same panel session — this used to be
    // setItemDescription(), called only when a description existed;
    // markup now applies to every item, so this always runs for the
    // setQty-driven (Group A) branch of the main write loop below.
    async function setItemMarkupAndDescription(searchName, markupPercent, description) {
      if (!description && (markupPercent === null || markupPercent === undefined)) return;
      var nsD = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

      // Step 1: Search for item → click LineItemResult to open edit panel
      var siD = document.getElementById('rc_select_17') || document.getElementById('rc_select_1');
      if (!siD) {
        var candsD = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input'));
        siD = candsD.find(function(el){ var id=el.id||''; return id.startsWith('rc_select_') && id!=='rc_select_0'; });
      }
      if (siD) {
        var contD = siD.closest('.ant-select-selector') || siD.parentElement;
        if (contD) { contD.click(); await _delay(200); }
        siD.focus(); await _delay(100);
        nsD.call(siD, searchName);
        siD.dispatchEvent(new Event('input',{bubbles:true}));
        siD.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(900);
        var dResult = null;
        var dItems = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
        for (var dli=0; dli<dItems.length; dli++) {
          if ((dItems[dli].innerText||'').trim().toLowerCase() === searchName.toLowerCase()) { dResult = dItems[dli]; break; }
        }
        if (dResult) {
          dResult.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          dResult.click();
          await _delay(1000);
        }
        nsD.call(siD, '');
        siD.dispatchEvent(new Event('input',{bubbles:true}));
        siD.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(400);
      }

      // Step 2: Find the exact <b> tag in the table with matching text → click its row to open side panel
      var targetRowD = null;
      for (var tdiD=0; tdiD<20; tdiD++) {
        var bTagsD = document.querySelectorAll('tr.proposalBaseLineItemContainerRow b');
        for (var tdi2D=0; tdi2D<bTagsD.length; tdi2D++) {
          if ((bTagsD[tdi2D].textContent||'').trim().toLowerCase() === searchName.toLowerCase()) {
            targetRowD = bTagsD[tdi2D].closest('tr.proposalBaseLineItemContainerRow');
            break;
          }
        }
        if (targetRowD) break;
        await _delay(150);
      }
      if (!targetRowD) { _log.push('⚠ setItemMarkupAndDescription: row not found for ' + searchName); return; }
      targetRowD.click();
      await _delay(800);

      // Step 3: Click the title ValueDisplay just to open the side panel's
      // editing context — do NOT write a new title value.
      var titleDisplayD = null;
      for (var tddD=0; tddD<15; tddD++) {
        var tDisplaysD = document.querySelectorAll('.ValueDisplay[data-testid$=".itemTitle"]');
        for (var tdi3D=0; tdi3D<tDisplaysD.length; tdi3D++) {
          if ((tDisplaysD[tdi3D].textContent||'').trim().toLowerCase() === searchName.toLowerCase()) {
            titleDisplayD = tDisplaysD[tdi3D]; break;
          }
        }
        if (titleDisplayD) break;
        await _delay(100);
      }
      if (titleDisplayD) {
        titleDisplayD.click();
        await _delay(400);
      } else {
        _log.push('⚠ setItemMarkupAndDescription: title ValueDisplay not found for ' + searchName);
      }

      // Step 4: Find + write the description textarea, if one was given
      // (no title/cost edits here). A missing textarea doesn't abort the
      // whole item — markup below still gets a chance to write.
      if (description) {
        var descAreaD = null;
        for (var daD = 0; daD < 30; daD++) {
          descAreaD = document.getElementById('description')
                   || document.querySelector('textarea[data-testid="description"]')
                   || document.querySelector('textarea[name="description"]');
          if (descAreaD) break;
          await _delay(150);
        }
        if (descAreaD) {
          descAreaD.scrollIntoView({ behavior: 'instant', block: 'center' });
          writeReactValue(descAreaD, description);
          await _delay(250);
        } else {
          _log.push('⚠ setItemMarkupAndDescription: description textarea not found for ' + searchName);
        }
      }

      await trySetMarkupPercent(markupPercent, 'setItemMarkupAndDescription: ' + searchName);

      // Step 5: Save — same coordinate-click + dirty-tracking-popup pattern as editExistingItem
      var sideElD = document.querySelector('.ant-layout-sider, aside');
      var saveXD = sideElD ? sideElD.getBoundingClientRect().right + 5 : 10;
      var saveYD = window.innerHeight / 2;
      var saveTargetD = document.elementFromPoint(saveXD, saveYD) || document.body;
      saveTargetD.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:saveXD,clientY:saveYD}));
      await _delay(150);
      saveTargetD.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:saveXD,clientY:saveYD}));
      await _delay(900);

      var dirtySaveD = null;
      for (var dsD=0; dsD<15; dsD++) {
        dirtySaveD = document.querySelector('[data-testid="dirtyTrackingSave"]');
        if (dirtySaveD) break;
        await _delay(150);
      }
      if (dirtySaveD) {
        dirtySaveD.click();
        await _delay(800);
      }

      _log.push('✓ setItemMarkupAndDescription: ' + searchName + (markupPercent !== null && markupPercent !== undefined ? ' → markup ' + markupPercent + '%' : '') + (description ? ' → "' + description + '"' : ''));
    }

    // Like editExistingItem, but scoped to a specific group's rows only —
    // "Place Holder" is not a unique title page-wide (multiple groups each
    // have their own default placeholder), so a global text search can
    // silently edit the wrong group's row. Reveal the target group, then
    // only walk ITS sibling rows for the placeholder (same scoping pattern
    // as groupHasRealItems / the Step 0.5 estimate check).
    async function editGroupPlaceHolder(groupTitle, newTitle, unitCost, description, markupPercent) {
      var nsG = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      var nsAreaG = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;

      var siG = findWorksheetSearchBar();
      if (siG) {
        var contG = siG.closest('.ant-select-selector') || siG.parentElement;
        if (contG) { contG.click(); await _delay(200); }
        siG.focus(); await _delay(100);
        nsG.call(siG, groupTitle);
        siG.dispatchEvent(new Event('input', { bubbles: true }));
        siG.dispatchEvent(new Event('change', { bubbles: true }));
        await _delay(900);
        var gResult = null;
        var gBTags = document.querySelectorAll('b');
        for (var gbi = 0; gbi < gBTags.length; gbi++) {
          if ((gBTags[gbi].textContent || '').trim().toLowerCase() === groupTitle.toLowerCase()) { gResult = gBTags[gbi]; break; }
        }
        if (!gResult) {
          var gItems = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
          for (var gii = 0; gii < gItems.length; gii++) {
            if ((gItems[gii].innerText || '').toLowerCase().includes(groupTitle.toLowerCase())) { gResult = gItems[gii]; break; }
          }
        }
        if (gResult) {
          var gClick = gResult.closest('.LineItemResult') || gResult.closest('[class*="Result"]') || gResult;
          gClick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          gClick.click(); await _delay(700);
        }
        nsG.call(siG, ''); siG.dispatchEvent(new Event('input', { bubbles: true })); siG.dispatchEvent(new Event('change', { bubbles: true })); await _delay(400);
      }

      var targetRow = null;
      for (var gri = 0; gri < 20; gri++) {
        var groupRow = null;
        var groupActionRows = document.querySelectorAll('.WorksheetGroupCellActions');
        for (var gi = 0; gi < groupActionRows.length; gi++) {
          var gTitleEl = groupActionRows[gi].querySelector('.proposalFormatGroupCellTitle');
          if (gTitleEl && (gTitleEl.textContent || '').trim().toLowerCase() === groupTitle.toLowerCase()) {
            groupRow = groupActionRows[gi].closest('tr') || groupActionRows[gi];
            break;
          }
        }
        if (groupRow) {
          var sib = groupRow.nextElementSibling;
          while (sib) {
            var nextGroupTitle = sib.querySelector && sib.querySelector('.proposalFormatGroupCellTitle');
            if (nextGroupTitle) break;
            var bTagG = sib.querySelector && sib.querySelector('b');
            if (sib.matches && sib.matches('tr.proposalBaseLineItemContainerRow') && bTagG &&
                (bTagG.textContent || '').trim().toLowerCase() === 'place holder') {
              targetRow = sib;
              break;
            }
            sib = sib.nextElementSibling;
          }
        }
        if (targetRow) break;
        await _delay(150);
      }

      if (!targetRow) {
        _log.push('⚠ editGroupPlaceHolder: Place Holder row not found in "' + groupTitle + '" group — creating new item instead');
        await createLineItem(newTitle, unitCost);
        return;
      }

      targetRow.click(); await _delay(800);
      // Scoped to targetRow specifically — NOT a page-wide scan. "Place
      // Holder" isn't unique page-wide (that's the whole reason for the
      // group-scoped lookup above); a global querySelectorAll here would
      // silently re-introduce the same wrong-group bug one step later.
      var titleDisplayG = null;
      for (var tddG = 0; tddG < 15; tddG++) {
        titleDisplayG = targetRow.querySelector('.ValueDisplay[data-testid$=".itemTitle"]');
        if (titleDisplayG) break;
        await _delay(100);
      }
      if (titleDisplayG) { titleDisplayG.click(); await _delay(400); }
      else { _log.push('⚠ editGroupPlaceHolder: title ValueDisplay not found for Place Holder in "' + groupTitle + '"'); }
      var titleInpG = null;
      for (var tiiG = 0; tiiG < 15; tiiG++) { titleInpG = document.querySelector('input[data-testid="itemTitle"]'); if (titleInpG) break; await _delay(100); }
      if (titleInpG) {
        writeReactValue(titleInpG, newTitle);
        await _delay(300);
      } else { _log.push('⚠ editGroupPlaceHolder: title input did not appear for Place Holder in "' + groupTitle + '"'); }
      if (description) {
        _log.push('  └ Writing Place Holder description: "' + description + '"…');
        var descAreaG = null;
        for (var daG = 0; daG < 30; daG++) {
          descAreaG = document.getElementById('description')
                   || document.querySelector('textarea[data-testid="description"]')
                   || document.querySelector('textarea[name="description"]');
          if (descAreaG) break;
          await _delay(150);
        }
        if (descAreaG) {
          descAreaG.scrollIntoView({ behavior:'instant', block:'center' });
          writeReactValue(descAreaG, description);
          await _delay(250);
          _log.push('  ✓ Place Holder description filled into textarea');
        } else {
          _log.push('⚠ editGroupPlaceHolder: description textarea not found for Place Holder in "' + groupTitle + '"');
        }
      }
      var costCellG = targetRow.querySelector('td[data-testid="cell-unitCost"] .ValueDisplay') ||
                     targetRow.querySelector('td[data-testid="cell-unitCost"]');
      if (costCellG) {
        costCellG.click(); await _delay(400);
        var costInpG = null;
        for (var ciiG = 0; ciiG < 15; ciiG++) { costInpG = document.querySelector('input[data-testid="unitCost"]'); if (costInpG) break; await _delay(100); }
        if (costInpG) {
          costInpG.focus();
          document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
          document.execCommand('insertText', false, String(unitCost));
          await _delay(300);
        } else { _log.push('⚠ editGroupPlaceHolder: cost input did not appear for Place Holder in "' + groupTitle + '"'); }
      } else { _log.push('⚠ editGroupPlaceHolder: cost cell not found for Place Holder in "' + groupTitle + '"'); }
      await trySetMarkupPercent(markupPercent, 'editGroupPlaceHolder: ' + groupTitle);
      var sideElG = document.querySelector('.ant-layout-sider, aside');
      var saveXG = sideElG ? sideElG.getBoundingClientRect().right + 5 : 10;
      var saveYG = window.innerHeight / 2;
      var saveTargetG = document.elementFromPoint(saveXG, saveYG) || document.body;
      saveTargetG.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: saveXG, clientY: saveYG })); await _delay(150);
      saveTargetG.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: saveXG, clientY: saveYG })); await _delay(900);
      var dirtySaveG = null;
      for (var dsG = 0; dsG < 15; dsG++) { dirtySaveG = document.querySelector('[data-testid="dirtyTrackingSave"]'); if (dirtySaveG) break; await _delay(150); }
      if (dirtySaveG) { dirtySaveG.click(); await _delay(800); }
      _log.push('✓ editGroupPlaceHolder: Place Holder in "' + groupTitle + '" → "' + newTitle + '" $' + unitCost);
    }

    var writeStartTime = performance.now();
    var stopped = false;

    if (customItemsList && customItemsList.length) {
      _log.push('');
      _log.push('── Custom Selection Allowances ──');
      for (var ci = 0; ci < customItemsList.length; ci++) {
        if (window.__keelWriteStop) { _log.push('⏹ Stopped'); stopped = true; break; }
        if (ci === 0) {
          // Reuse the default "Place Holder" row instead of adding a new
          // item alongside it — rename/reprice it in place, same as the
          // Driveway/Landscaping Allowance edits below. Group-scoped (not
          // editExistingItem) since "Place Holder" isn't unique page-wide.
          await editGroupPlaceHolder('Custom Selection Allowances', customItemsList[ci].name, customItemsList[ci].unitCost, customItemsList[ci].description, markupPercent);
        } else {
          await createLineItem(customItemsList[ci].name, customItemsList[ci].unitCost, customItemsList[ci].description, markupPercent);
        }
      }
    }

    for (var i = 0; !stopped && i < itemsList.length; i++) {
      if (window.__keelWriteStop) { _log.push('⏹ Stopped'); stopped = true; break; }
      var editOpt = editableItems[itemsList[i].name];
      if (editOpt) {
        await editExistingItem(itemsList[i].name, editOpt.name, editOpt.unitCost, editOpt.description, markupPercent);
      } else {
        await setQty(itemsList[i].name, itemsList[i].qty, itemsList[i].isUnitCost);
        // Markup applies to every item now (not just ones with a tier
        // description) — always call this, it no-ops internally on
        // whichever of the two is actually absent. EXCEPT Realtor Fees:
        // its Unit Cost is a real market rate straight from the
        // SALES TO EDIT - REALTOR cost_items row, not a total that
        // already has markup baked into every other line, but it's
        // still kept at 0% by deliberate choice (unchanged from before) —
        // see fetchUnitCostsFromSupabase/QUANTITY_ITEM_NAME_TO_COST_ITEM_NAME
        // in popup.js for how its qty/unitCost actually get resolved now.
        var itemMarkupPercent = (itemsList[i].name === 'Realtor Fees') ? 0 : markupPercent;
        await setItemMarkupAndDescription(itemsList[i].name, itemMarkupPercent, itemsList[i].description);
        // Supabase-sourced unit cost — only set when the caller actually
        // resolved one (no match in cost_items => undefined => skipped,
        // leaving BuilderTrend's own preset rate untouched rather than
        // guessing or writing a zero). Reuses setQty's own isUnitCost=true
        // path (already proven — this is the same mechanism the Realtor
        // Fees grand-total write already uses below) rather than the
        // separate side-panel approach setItemUnitCost() used, which opens
        // a different BT UI surface than the small popup setQty already
        // knows how to drive.
        if (itemsList[i].unitCost !== undefined && itemsList[i].unitCost !== null) {
          await setQty(itemsList[i].name, itemsList[i].unitCost, true);
        }
      }
    }

    if (!stopped) {
      await _delay(1500);

      if (siteOptionsList && siteOptionsList.length) {
        _log.push('');
        _log.push('── Site Options ──');
        for (var si2 = 0; si2 < siteOptionsList.length; si2++) {
          if (window.__keelWriteStop) { _log.push('⏹ Stopped'); stopped = true; break; }
          if (siteOptionsList[si2].existingLine) continue;
          await createSiteItem(siteOptionsList[si2].name, siteOptionsList[si2].parentGroup, siteOptionsList[si2].unitCost, markupPercent);
        }
      }
    }


    // Custom-pricing-needed notification email — webpage Write to Estimate
    // only (notifyEstimator/notifyItemNames only ever arrive non-empty from
    // background.js's OPEN_ESTIMATE_TAB_PICKER handler; the extension's own
    // popup/panel write paths explicitly zero these out). Runs only on a
    // completed, non-stopped write.
    if (!stopped && notifyEstimator && notifyItemNames && notifyItemNames.length) {
      try {
        var jobNameEl = document.querySelector('.estimate-breadcrumb-item')
                     || document.querySelector('[data-testid^="breadcrumb-JOB"]');
        var jobName = '';
        if (jobNameEl) {
          jobName = (jobNameEl.textContent || '').trim().replace(/^JOB:\s*/i, '');
        }
        if (!jobName) {
          _log.push('⚠ Could not find the job name breadcrumb on this page — sending notification without one');
          jobName = '(unknown job)';
        }

        // notifyItemNames entries are { name, price } — price is what the
        // item was just written to the estimate at, so the email can show
        // the estimator the actual current number, not just which items to
        // look at. location.href is this exact job's Estimate page (this
        // function runs injected directly into it), so the email can link
        // straight back to it instead of a generic BuilderTrend URL.
        _log.push('Sending custom-pricing-needed notification for: ' + notifyItemNames.map(function (it) { return it.name; }).join(', '));
        var notifyRes = await fetch('https://fujddlemswhbdqrhpekt.supabase.co/functions/v1/send-pricing-notification', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1amRkbGVtc3doYmRxcmhwZWt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMTYzODcsImV4cCI6MjA5OTg5MjM4N30.pR2IINeUB6RDAXBG6IDHrLc3diW8TNYYN1jAIEdXFm4',
            'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1amRkbGVtc3doYmRxcmhwZWt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMTYzODcsImV4cCI6MjA5OTg5MjM4N30.pR2IINeUB6RDAXBG6IDHrLc3diW8TNYYN1jAIEdXFm4'
          },
          body: JSON.stringify({ jobName: jobName, jobUrl: location.href, items: notifyItemNames })
        });
        var notifyBody = await notifyRes.json().catch(function () { return {}; });
        if (notifyRes.ok && notifyBody.ok) {
          _log.push('✓ Notification email sent to the estimator');
        } else {
          _log.push('✗ Notification email failed: ' + (notifyBody.error || ('HTTP ' + notifyRes.status)));
        }
      } catch (notifyErr) {
        _log.push('✗ Notification email failed: ' + notifyErr.message);
      }
    }

    var totalWriteTime = performance.now() - writeStartTime;
    var totalSeconds = totalWriteTime / 1000;
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = (totalSeconds % 60).toFixed(1);
    var timeFormat = minutes > 0 ? minutes + 'm ' + seconds + 's' : seconds + 's';
    _log.push('');
    _log.push('═══ TOTAL TIME: ' + timeFormat + ' ═══');

    return {
      ok: _log.filter(function (l) { return l.startsWith('✓'); }).length,
      fail: _log.filter(function (l) { return l.startsWith('✗'); }).length,
      lines: _log,
      stopped: stopped
    };
  } catch (e) {
    return { ok: 0, fail: 1, lines: ['✗ Script error: ' + e.message] };
  }
}

// ═══════════════════════════════════════════════════════════
// Client Preview flow — runs in the chosen tab via
// chrome.scripting.executeScript (same as popup.js)
// ═══════════════════════════════════════════════════════════
async function selectTabForClientPreview(tab, titleEl, statusEl, logEl, slowConnection) {
  function delay(ms) { return new Promise(function (r) { setTimeout(r, slowConnection ? ms * 2 : ms); }); }

  titleEl.textContent = 'Client Preview: ' + (tab.title || tab.url);
  statusEl.className = 'progress-status';
  statusEl.innerHTML = '<span class="spin"></span>Bringing tab into focus…';
  logEl.textContent = '';

  function log(msg) {
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
  function setStatus(msg) {
    statusEl.innerHTML = '<span class="spin"></span>' + msg;
  }

  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await delay(400);

    // ── Ported directly from popup.js runClientPreviewFlow (the static
    // extension dropdown's "Start Prelim - Budget Client Preview" button) ──
    var tabId = tab.id;

    // Step 0: Read grand total from estimate footer (before navigating away)
    // Polls instead of a single querySelector — this tab was just force-reloaded
    // (Option B fix) and BT's grid can take several seconds to fetch/render the
    // footer after a fresh load, so a one-shot read can race the page and
    // silently return 0, which skips the entire editor-fill/PUT/Save block below.
    // popup.js's runClientPreviewFlow never reloads its tab first, so it never
    // hits this race — that's why this file needs the poll and popup.js doesn't.
    log('Reading estimate grand total…');
    var _totalRes = await chrome.scripting.executeScript({
      target: { tabId: tabId }, world: 'MAIN',
      func: async function(slowConnection) {
        function delay(ms) { return new Promise(function(r){ setTimeout(r, slowConnection ? ms * 2 : ms); }); }
        var waited = 0;
        while (waited < 10000) {
          var span = document.querySelector('.BTGridFooterCell--ellipsis span[dir="ltr"]');
          if (span) {
            var txt = (span.innerText || '').trim();
            var m = txt.match(/^\$([\d,]+\.?\d*)$/);
            if (m) {
              var val = parseFloat(m[1].replace(/,/g, ''));
              if (val > 0) return val;
            }
          }
          await delay(300);
          waited += 300;
        }
        return 0;
      },
      args: [slowConnection]
    });
    var _grandTotal = (_totalRes && _totalRes[0] && _totalRes[0].result) || 0;
    if (_grandTotal > 0) log('Grand total: $' + _grandTotal.toLocaleString('en-US'));
    else log('Warning: grand total not found — budget range will be skipped');

    // Step 0.5: Check the Estimate grid (before Build Proposal is clicked) for
    // (a) "Preferred Lender Incentive" qty > 0, and (b) any real item already
    // written under "Custom Selection Allowances". These feed the group-expand
    // step below as EXTRA reasons to expand a section — additive to, not a
    // replacement for, the existing rendered-panel-title check there.
    log('Checking estimate for lender/custom-allowance items…');
    var _estFlagsRes = await chrome.scripting.executeScript({
      target: { tabId: tabId }, world: 'MAIN',
      func: async function(slowConnection) {
        function delay(ms) { return new Promise(function(r){ setTimeout(r, slowConnection ? ms * 2 : ms); }); }
        function findWorksheetSearchBar() {
          var collapseBtn = Array.from(document.querySelectorAll('button')).find(function(b) {
            return (b.textContent || '').includes('Collapse all');
          });
          if (collapseBtn) {
            var el = collapseBtn;
            while (el && el !== document.body) {
              var inp = el.querySelector('input[role="combobox"].ant-select-selection-search-input');
              if (inp) return inp;
              el = el.parentElement;
            }
          }
          return document.getElementById('rc_select_17') || document.getElementById('rc_select_1') || null;
        }
        var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        var flags = { lenderQtyPositive: false, customHasItems: false, debug: {} };

        // (a) Preferred Lender Incentive quantity — the estimate grid is
        // virtualized, so a row not currently scrolled into view doesn't exist
        // in the DOM at all. Search + click the result first (same lookup
        // editExistingItem uses) to scroll it into view, THEN scan for the row.
        // Qty itself is shown inside a popup, not as plain text — open it, read
        // the spinbutton's current value, then Escape to close without saving.
        var si = findWorksheetSearchBar();
        flags.debug.searchBarFound = !!si;
        if (si) {
          var cont = si.closest('.ant-select-selector') || si.parentElement;
          if (cont) { cont.click(); await delay(200); }
          si.focus(); await delay(100);
          nativeSetter.call(si, 'Preferred Lender Incentive');
          si.dispatchEvent(new Event('input', { bubbles: true }));
          si.dispatchEvent(new Event('change', { bubbles: true }));
          await delay(900);
          var searchResult = null;
          var resultEls = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
          for (var ri = 0; ri < resultEls.length; ri++) {
            if ((resultEls[ri].innerText || '').trim().toLowerCase() === 'preferred lender incentive') { searchResult = resultEls[ri]; break; }
          }
          flags.debug.lenderSearchResultFound = !!searchResult;
          if (searchResult) {
            searchResult.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            searchResult.click();
            await delay(1000);
          }
          nativeSetter.call(si, '');
          si.dispatchEvent(new Event('input', { bubbles: true }));
          si.dispatchEvent(new Event('change', { bubbles: true }));
          await delay(400);
        }

        var lenderRow = null;
        for (var lri = 0; lri < 20; lri++) {
          var bTags = document.querySelectorAll('tr.proposalBaseLineItemContainerRow b');
          for (var bi = 0; bi < bTags.length; bi++) {
            if ((bTags[bi].textContent || '').trim().toLowerCase() === 'preferred lender incentive') {
              lenderRow = bTags[bi].closest('tr.proposalBaseLineItemContainerRow');
              break;
            }
          }
          if (lenderRow) break;
          await delay(150);
        }
        flags.debug.lenderRowFound = !!lenderRow;
        if (lenderRow) {
          lenderRow.click();
          await delay(500);
          var titleDisplay = null;
          var tDisplays = document.querySelectorAll('.ValueDisplay[data-testid$=".itemTitle"]');
          for (var ti = 0; ti < tDisplays.length; ti++) {
            if ((tDisplays[ti].textContent || '').trim().toLowerCase() === 'preferred lender incentive') { titleDisplay = tDisplays[ti]; break; }
          }
          flags.debug.titleDisplayFound = !!titleDisplay;
          if (titleDisplay) {
            titleDisplay.click();
            await delay(400);
            var qtyInput = document.querySelector('input[role="spinbutton"].ant-input-number-input')
                        || document.querySelector('input[role="spinbutton"]')
                        || document.querySelector('input.ant-input-number-input');
            if (qtyInput) {
              var qv = parseFloat(qtyInput.value);
              flags.debug.qtyRead = qtyInput.value;
              flags.lenderQtyPositive = !isNaN(qv) && qv > 0;
            } else {
              flags.debug.qtyRead = 'input not found';
            }
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
            if (document.activeElement) document.activeElement.blur();
            document.body.click();
            await delay(200);
          }
        }

        // (b) Custom Selection Allowances — same search-and-reveal step
        // createLineItem uses to find the group's "+" button, then walk
        // sibling rows after the group header until the next group header.
        var si2 = findWorksheetSearchBar();
        flags.debug.groupSearchBarFound = !!si2;
        if (si2) {
          var cont2 = si2.closest('.ant-select-selector') || si2.parentElement;
          if (cont2) { cont2.click(); await delay(200); }
          si2.focus(); await delay(100);
          nativeSetter.call(si2, 'Custom Selection Allowances');
          si2.dispatchEvent(new Event('input', { bubbles: true }));
          si2.dispatchEvent(new Event('change', { bubbles: true }));
          await delay(900);
          var liResult = null;
          var bTagsSearch = document.querySelectorAll('b');
          for (var lbi = 0; lbi < bTagsSearch.length; lbi++) {
            if ((bTagsSearch[lbi].textContent || '').trim().toLowerCase() === 'custom selection allowances') { liResult = bTagsSearch[lbi]; break; }
          }
          if (!liResult) {
            var liItems = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
            for (var lii = 0; lii < liItems.length; lii++) {
              if ((liItems[lii].innerText || '').toLowerCase().includes('custom selection allowances')) { liResult = liItems[lii]; break; }
            }
          }
          flags.debug.customSearchResultFound = !!liResult;
          if (liResult) {
            var liClick = liResult.closest('.LineItemResult') || liResult.closest('[class*="Result"]') || liResult;
            liClick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            liClick.click();
            await delay(700);
          }
          nativeSetter.call(si2, '');
          si2.dispatchEvent(new Event('input', { bubbles: true }));
          si2.dispatchEvent(new Event('change', { bubbles: true }));
          await delay(400);
        }

        var groupRow = null;
        for (var gri = 0; gri < 20; gri++) {
          var groupActionRows = document.querySelectorAll('.WorksheetGroupCellActions');
          for (var gi = 0; gi < groupActionRows.length; gi++) {
            var gTitleEl = groupActionRows[gi].querySelector('.proposalFormatGroupCellTitle');
            if (gTitleEl && (gTitleEl.textContent || '').trim().toLowerCase() === 'custom selection allowances') {
              groupRow = groupActionRows[gi].closest('tr') || groupActionRows[gi];
              break;
            }
          }
          if (groupRow) break;
          await delay(150);
        }
        flags.debug.groupRowFound = !!groupRow;
        if (groupRow) {
          var sib = groupRow.nextElementSibling;
          var foundNames = [];
          while (sib) {
            var nextGroupTitle = sib.querySelector && sib.querySelector('.proposalFormatGroupCellTitle');
            if (nextGroupTitle) break;
            var bTag = sib.querySelector && sib.querySelector('b');
            if (sib.matches && sib.matches('tr.proposalBaseLineItemContainerRow') && bTag) {
              var itemName = (bTag.textContent || '').trim();
              if (itemName && !/^place\s*holder$/i.test(itemName)) foundNames.push(itemName);
            }
            sib = sib.nextElementSibling;
          }
          flags.debug.customItemNames = foundNames;
          flags.customHasItems = foundNames.length > 0;
        }

        return flags;
      },
      args: [slowConnection]
    });
    var _estFlags = (_estFlagsRes && _estFlagsRes[0] && _estFlagsRes[0].result) || { lenderQtyPositive: false, customHasItems: false };
    log('Estimate check: lender qty>0=' + _estFlags.lenderQtyPositive + ', custom allowance items=' + _estFlags.customHasItems + ' ' + JSON.stringify(_estFlags.debug || {}));

    // Step 1: Click buildProposal button
    // Same post-reload race as Step 0 — poll for the button instead of a single read.
    log('Opening proposal builder…');
    setStatus('Opening proposal…');
    var _buildBtnRes = await chrome.scripting.executeScript({
      target: { tabId: tabId }, world: 'MAIN',
      func: async function(slowConnection) {
        function delay(ms) { return new Promise(function(r){ setTimeout(r, slowConnection ? ms * 2 : ms); }); }
        var waited = 0;
        while (waited < 10000) {
          var btn = document.querySelector('[data-testid="buildProposal"]');
          if (btn) { btn.click(); return { found: true }; }
          await delay(300);
          waited += 300;
        }
        return { found: false, url: window.location.href };
      },
      args: [slowConnection]
    });
    var _buildBtnStatus = _buildBtnRes && _buildBtnRes[0] && _buildBtnRes[0].result;
    if (_buildBtnStatus && !_buildBtnStatus.found) {
      log('⚠ "Build Proposal" button not found on this tab (url: ' + _buildBtnStatus.url + ') — make sure the picked tab is on the estimate page for this job');
    }
    await delay(2500);

    // Step 1.5: Fill editor1 (intro) and editor2 (closing) via CKEditor API
    if (_grandTotal > 0) {
      log('Filling proposal editors…');
      setStatus('Writing proposal text…');
      var _lowFmt  = '$' + Math.round(_grandTotal * 0.99).toLocaleString('en-US');
      var _highFmt = '$' + Math.round(_grandTotal * 1.10).toLocaleString('en-US');
      var _midFmt  = '$' + Math.round(_grandTotal).toLocaleString('en-US');

      // Read sales notes from SALES NOTES sheet tab
      var _salesNotesText = '';
      try {
        var _snResp = await new Promise(function(resolve, reject) {
          chrome.runtime.sendMessage(
            { action: 'READ_CELLS_RANGE_TAB', tab: 'SALES NOTES', range: 'A1' },
            function(resp) {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || 'No response'));
              resolve(resp);
            }
          );
        });
        _salesNotesText = ((_snResp.data && _snResp.data[0] && _snResp.data[0][0]) || '').trim();
      } catch(e) { log('⚠ Could not read sales notes: ' + e.message); }

      var _notesBlock = '';
      if (_salesNotesText) {
        var _noteLines = _salesNotesText.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
        var _notesBody = _noteLines.map(function(l){
          return l.startsWith('-') ? '<li>' + l.slice(1).trim() + '</li>' : '<p>' + l + '</p>';
        }).join('');
        if (_noteLines.some(function(l){ return l.startsWith('-'); })) _notesBody = '<ul>' + _notesBody + '</ul>';
        _notesBlock = '<p>&nbsp;</p><h2><span style="font-size:16px;"><strong>NOTES</strong></span></h2><hr />' + _notesBody;
      }

      var _introHtml = [
        '<p><em>This is a preliminary estimate for budgeting purposes only &mdash; not a contract or binding price.</em></p>',
        '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;',
        '<table align="center" border="1" cellpadding="1" cellspacing="1" style="width:500px;">',
        '<tbody><tr><td style="text-align: center;">',
        '<h3><span style="font-size:16px;"><strong>ESTIMATED BUDGET RANGE</strong></span></h3>',
        '<h1><span style="font-size:28px;"><strong>' + _lowFmt + ' &ndash; ' + _highFmt + '</strong></span></h1>',
        '<p><span style="font-size:16px;"><strong>MIDPOINT: ' + _midFmt + '</strong></span></p>',
        '</td></tr></tbody></table>',
        _notesBlock,
        '&nbsp;',
        '<p>&nbsp;</p>',
        '<h2><span style="font-size:16px;"><strong>WHAT&#39;S INCLUDED IN YOUR ESTIMATE&nbsp;</strong></span></h2>',
        '<p><hr /><strong>Design &amp; Pre-Construction</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Complete architectural plans, engineering, permits, surveys, and inspections</p>',
        '<p><hr /><strong>Foundation</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; &nbsp;Standard footings, walls, waterproofing, and backfill</p>',
        '<p><hr /><strong>Framing &amp; Structure</strong>&nbsp; &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Full framing package including lumber, trusses, engineered joists, and stairs</p>',
        '<p><hr /><strong>Exterior Envelope</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Siding exterior with architectural shingle roofing, gutters, and all exterior trim</p>',
        '<p><hr /><strong>Mechanical Systems</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; &nbsp;Complete HVAC, plumbing rough &amp; finish, and electrical rough &amp; finish</p>',
        '<p><hr /><strong>Insulation &amp; Drywall</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; &nbsp; Full insulation to code, drywall, and interior/exterior paint</p>',
        '<p><hr /><strong>Interior Finishes</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &nbsp; Interior doors, trim, hardware, and custom carpentry allowance</p>',
        '<p><hr /><strong>Site Work</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Site clearing, grading, driveway, and all utilities including municipal tap fees</p>',
        '<p><hr /><strong>Decks / Porches</strong>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Porches and decks finished per spec</p>'
      ].join('');
      var _closingHtml = [
        '<h2><span style="font-size:16px;"><span style="color:#000000;"><strong>BUDGET PRICING SUMMARY</strong></span></span></h2>',
        '<hr />',
        '<p>The pricing shown in this proposal represents the initial contract amount for Milestone 1 and is based on the information available at this stage of the project. Because detailed selections and final site confirmations have not yet been completed, this is not the final contract price.</p>',
        '<p>This budget is intended to establish feasibility, provide direction, and support loan preapproval. As plans are finalized, site conditions are verified, and selections are made, the contract pricing will be refined to reflect the specific scope and investment of your home.</p>',
        '<p>Any adjustments resulting from confirmed site conditions, completed selections, or requested upgrades will be clearly communicated as information becomes available.</p>',
        '<h2><span style="font-size:16px;"><span style="color:#000000;"><strong>ALLOWANCE STRUCTURE &amp; BUDGET ASSUMPTIONS</strong></span></span></h2>',
        '<hr /><h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Allowances</strong></span></span></h3>',
        '<p>This budget includes allowances for major finish categories. These are placeholder amounts intended to provide a realistic starting point and do not reflect specific brands, products, or final selections at this stage. Final costs will be determined once selections are completed.</p>',
        '<ul><li>If selections exceed the allowance, the difference will be added to the project cost.</li>',
        '<li>If selections come in under the allowance, a credit will be applied.</li></ul>',
        '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Budget Assumptions</strong></span></span></h3>',
        '<p>This budget is based on the following standard residential construction assumptions. If any of these conditions differ, adjustments to cost, design, or schedule may be required.</p>',
        '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Lot &amp; Approvals<em>&nbsp;</em></strong></span></span></h3>',
        '<ul><li><em>T</em>he lot is legally buildable and compliant with zoning, setbacks, easements, floodplain, and municipal requirements.</li>',
        '<li>No rezoning, variances, special use permits, or additional jurisdictional approvals are required.</li>',
        '<li>No unusual HOA or architectural review requirements beyond typical residential standards.</li></ul>',
        '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Site &amp; Soil Conditions</strong></span></span></h3>',
        '<ul><li>Standard soil conditions suitable for typical residential foundation construction.</li>',
        '<li>No rock excavation, blasting, or unsuitable soils requiring remediation.</li>',
        '<li>Standard foundation type as reflected in current plans.</li>',
        '<li>No unanticipated environmental conditions, including wetlands or protected areas.</li></ul>',
        '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Utilities &amp; Infrastructure&nbsp;</strong></span></span></h3>',
        '<ul><li>Standard utility access is available at the home site.</li>',
        '<li>No off-site utility extensions or upgrades are required.</li>',
        '<li>No extraordinary stormwater management requirements beyond typical residential construction.</li></ul>',
        '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Construction Conditions&nbsp;</strong></span></span></h3>',
        '<ul><li>No unusual site constraints affecting access, staging, or logistics.</li>',
        '<li>No material shortages or trade disruptions beyond normal market conditions.</li>',
        '<li>Plans provided are accurate and complete for this phase of pricing.</li></ul>',
        '<p>If any of these assumptions prove to be inaccurate, additional costs may be incurred.</p>',
        '<h2><span style="font-size:16px;"><strong>ITEMS NOT INCLUDED IN THIS BUDGET</strong></span></h2>',
        '<hr />Unless specifically noted elsewhere in the proposal, the following items are not included:',
        '<ul><li>Building permits and government fees beyond the municipality&#39;s building permit</li>',
        '<li>Utility provider fees and service connection charges</li>',
        '<li>Well and septic systems (refer to allowances, if applicable)</li>',
        '<li>Landscaping beyond minimum stabilization</li>',
        '<li>Off-site improvements or upgrades required by local authorities</li></ul>',
        '<p>Depending on the lot, jurisdiction, or lender requirements, these items may be required and are often paid directly by the homeowner or financed separately.</p>',
        '<h2><span style="font-size:16px;"><strong>WHAT COMES NEXT</strong></span></h2>',
        '<hr />Milestone 2 is where your home begins to take shape. During this phase, we align your site, structural decisions, and exterior selections to significantly reduce pricing uncertainty and move toward a refined price range.',
        '<h3><span style="font-size:14px;"><strong><span style="color:#133d59;">Milestone 2&nbsp;&mdash; Site, Design, and Structural Alignment</span></strong></span><br /><br />',
        '<span style="font-size: 13px;"><strong>Purpose: </strong>Lock in the size, structure, and exterior of your home to reduce uncertainty and bring greater clarity to pricing.</span></h3>',
        '<h3><br /><span style="font-size:14px;"><strong><span style="color:#133d59;">During This Phase &mdash; You Provide</span></strong></span></h3>',
        '<ul><li>Final approval of plan layout and square footage.</li>',
        '<li>Exterior selections including roof, windows, siding, doors, and related finishes</li>',
        '<li>Completed site design including house location, driveway layout, clearing, and utilities.</li></ul>',
        '<h3><span style="font-size:14px;"><span style="color:#133d59;"><strong>Keel Provides:</strong>&nbsp;</span></span></h3>',
        '<ul><li>&quot;Bid Set&quot; floor plans</li>',
        '<li>Defined structural system</li>',
        '<li>Exterior and site selections priced</li>',
        '<li>A refined price range.</li></ul>',
        '<p style="text-align: center;"><span style="color:#999999;"><strong>MAKE THIS HOME YOURS</strong></span></p>',
        '<p style="text-align: center;"><span style="color:#999999;">With the design aligned and pricing refined, we move confidently into the next milestone and continue turning your plans into reality.</span></p>',
        '<p style="text-align: center;"><em>Keel Custom Homes &bull; Preliminary Budget Estimate &bull; Confidential</em></p>'
      ].join('');
      var _editorResult = await chrome.scripting.executeScript({
        target: { tabId: tabId }, world: 'MAIN',
        func: async function(introHtml, closingHtml, slowConnection) {
          function delay(ms) { return new Promise(function(r){ setTimeout(r, slowConnection ? ms * 2 : ms); }); }
          var _dbg = { ckEditors: 0, jobId: null, getOk: null, putStatus: null, branch: null };
          var titleInput = document.querySelector('#title[data-testid="title"]');
          if (titleInput) {
            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(titleInput, 'Preliminary Budget Estimate');
            titleInput.dispatchEvent(new Event('input', { bubbles: true }));
            titleInput.dispatchEvent(new Event('change', { bubbles: true }));
          }

          var waited = 0;
          while (waited < 8000) {
            if (window.CKEDITOR && CKEDITOR.instances && Object.keys(CKEDITOR.instances).length >= 2) break;
            await delay(300);
            waited += 300;
          }
          if (!window.CKEDITOR) { _dbg.branch = 'no-ckeditor'; return _dbg; }
          var editorKeys = Object.keys(CKEDITOR.instances);
          _dbg.ckEditors = editorKeys.length;
          if (editorKeys.length < 2) { _dbg.branch = 'too-few-editors'; return _dbg; }
          var editorA = CKEDITOR.instances[editorKeys[0]];
          var editorB = CKEDITOR.instances[editorKeys[1]];

          editorA.setData(introHtml);
          editorB.setData(closingHtml);
          await delay(300);

          var jobId = null;
          var resources = performance.getEntriesByType('resource');
          for (var ri = 0; ri < resources.length; ri++) {
            var rm = resources[ri].name.match(/\/apix\/v2\/Proposals\/draft\?jobId=(\d+)/);
            if (rm) { jobId = rm[1]; break; }
          }
          _dbg.jobId = jobId;

          console.log('[Keel] jobId found:', jobId);
          if (jobId) {
            console.log('[Keel] GETting current draft via XHR...');
            var draft = await new Promise(function(resolve) {
              var xhr = new XMLHttpRequest();
              xhr.open('GET', '/apix/v2/Proposals/draft?jobId=' + jobId, true);
              xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
              xhr.setRequestHeader('portaltype', '1');
              xhr.onload = function() {
                if (xhr.status === 200) {
                  try { resolve(JSON.parse(xhr.responseText)); } catch(e) { resolve(null); }
                } else { resolve(null); }
              };
              xhr.onerror = function() { resolve(null); };
              xhr.send();
            });
            _dbg.getOk = !!draft;
            if (!draft) {
              console.log('[Keel] GET failed — falling back to Save button');
              _dbg.branch = 'no-draft-savebtn';
              var saveBtn = document.querySelector('[data-testid="save"]');
              if (saveBtn) { saveBtn.click(); await delay(3000); }
            } else {
              console.log('[Keel] GET ok');
              _dbg.branch = 'full-put';
              var putBody = {};
              Object.keys(draft).forEach(function(k) {
                if (draft[k] && typeof draft[k] === 'object' && !Array.isArray(draft[k])) {
                  Object.assign(putBody, draft[k]);
                }
              });
              if (!('categories' in putBody) && putBody.formatItems) {
                putBody.categories = putBody.formatItems;
              }
              if (!('formatOptions' in putBody)) {
                var dOpts = putBody.displayOptions || {};
                var pConf = putBody.proposalDisplayConfig || {};
                putBody.formatOptions = {
                  body: dOpts.body,
                  header: dOpts.header,
                  printoutType: dOpts.printoutType,
                  includeSpecs: dOpts.includeSpecs || false,
                  showAddress: putBody.showAddress || false,
                  showOwnerContactInfo: putBody.showOwnerContactInfo || false,
                  showPrintoutInfo: putBody.showPrintoutInfo || false,
                  proposalLayout: pConf.proposalLayout != null ? pConf.proposalLayout : 0,
                  hasSingleSelectCostTypes: pConf.hasSingleSelectCostTypes || false
                };
              }
              if (Array.isArray(putBody.categories)) {
                putBody.categories.forEach(function(cat) {
                  if (cat.items && !cat.lineItems) {
                    cat.lineItems = cat.items;
                    delete cat.items;
                  }
                });
              }
              putBody.requireSignatures = false;
              putBody.requiredSignatureUsers = [];
              if (putBody.columnsToDisplay && Array.isArray(putBody.columnsToDisplay.value)) {
                putBody.columnsToDisplay = putBody.columnsToDisplay.value;
              }
              putBody.introductionText = introHtml;
              putBody.closingText = closingHtml;
              var bodyStr = JSON.stringify(putBody);
              console.log('[Keel] Sending via XHR, body size:', bodyStr.length);

              var xhrStatus = await new Promise(function(resolve) {
                var xhr = new XMLHttpRequest();
                xhr.open('PUT', '/apix/v2/Proposals/draft?jobId=' + jobId, true);
                xhr.setRequestHeader('content-type', 'application/merge-patch+json');
                xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
                xhr.setRequestHeader('portaltype', '1');
                xhr.onload = function() {
                  console.log('[Keel] XHR status:', xhr.status, xhr.responseText);
                  resolve(xhr.status);
                };
                xhr.onerror = function() { console.log('[Keel] XHR error'); resolve(0); };
                xhr.send(bodyStr);
              });
              _dbg.putStatus = xhrStatus;
              await delay(1500);
              editorA.setData(introHtml);
              editorB.setData(closingHtml);
              await delay(300);
            }
          } else {
            console.log('[Keel] jobId NOT found — falling back to Save button');
            _dbg.branch = 'no-jobid-savebtn';
            var saveBtn2 = document.querySelector('[data-testid="save"]');
            if (saveBtn2) { saveBtn2.click(); await delay(3000); }
          }
          return _dbg;
        },
        args: [_introHtml, _closingHtml, slowConnection]
      });
      var _saveResult = _editorResult && _editorResult[0] && _editorResult[0].result;
      log('Proposal save result: ' + JSON.stringify(_saveResult));
      await chrome.scripting.executeScript({
        target: { tabId: tabId }, world: 'MAIN',
        func: async function() {
          var resources = performance.getEntriesByType('resource');
          var jobId = null;
          for (var ri = 0; ri < resources.length; ri++) {
            var rm = resources[ri].name.match(/\/apix\/v2\/Proposals\/draft\?jobId=(\d+)/);
            if (rm) { jobId = rm[1]; break; }
          }
          if (!jobId) return;
          var xhr = new XMLHttpRequest();
          xhr.open('GET', '/apix/v2/Proposals/draft?jobId=' + jobId, false);
          xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
          xhr.setRequestHeader('portaltype', '1');
          xhr.send();
          if (xhr.status === 200) {
            try {
              var d = JSON.parse(xhr.responseText);
              var intro = (d.proposal && d.proposal.introductionText) || '';
              console.log('[Keel] Verify GET introductionText starts with:', intro.slice(0, 80));
            } catch(e) {}
          }
        }
      });
      await delay(2000);
      await chrome.scripting.executeScript({
        target: { tabId: tabId }, world: 'MAIN',
        func: function() {
          var cb = document.querySelector('[data-testid="requireSignatures"]');
          if (cb) {
            var wrapper = cb.closest('.ant-checkbox-wrapper');
            if (wrapper && wrapper.classList.contains('ant-checkbox-wrapper-checked')) {
              cb.click();
              console.log('[Keel] Unchecked requireSignatures');
            }
          }
        }
      });

      // Click BT's own Save button before reloading — the raw PUT patches the
      // draft record, but Save may be what triggers BT to regenerate whatever
      // rendered/published snapshot the Client Preview tab actually reads from.
      log('Clicking Save…');
      setStatus('Saving…');
      await chrome.scripting.executeScript({
        target: { tabId: tabId }, world: 'MAIN',
        func: function() {
          var saveBtn = document.querySelector('[data-testid="save"]');
          if (saveBtn) { saveBtn.click(); return { found: true }; }
          return { found: false };
        }
      });
      await delay(2000);

      // Lock our text back in AFTER Save — BT's own Save handler may read
      // introductionText/closingText from a React/Redux copy that was
      // hydrated when "Build Proposal" first loaded (before our PUT ever
      // ran), not from CKEditor's live buffer. If so, clicking Save just
      // overwrote our earlier PUT with stale/default text, and the reload
      // below would only reveal that corruption. Re-run the same full
      // GET -> PUT with our HTML, last, right before the reload, so our
      // text is guaranteed to be what the server actually holds afterward.
      log('Locking proposal text after Save…');
      var _lockResult = await chrome.scripting.executeScript({
        target: { tabId: tabId }, world: 'MAIN',
        func: async function(introHtml, closingHtml, slowConnection) {
          function delay(ms) { return new Promise(function(r){ setTimeout(r, slowConnection ? ms * 2 : ms); }); }
          var _lockDbg = { jobId: null, getOk: null, putStatus: null, verifyLen: null };
          var jobId = null;
          var resources = performance.getEntriesByType('resource');
          for (var ri = 0; ri < resources.length; ri++) {
            var rm = resources[ri].name.match(/\/apix\/v2\/Proposals\/draft\?jobId=(\d+)/);
            if (rm) { jobId = rm[1]; break; }
          }
          _lockDbg.jobId = jobId;
          if (!jobId) return _lockDbg;

          var draft = await new Promise(function(resolve) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', '/apix/v2/Proposals/draft?jobId=' + jobId, true);
            xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
            xhr.setRequestHeader('portaltype', '1');
            xhr.onload = function() {
              if (xhr.status === 200) { try { resolve(JSON.parse(xhr.responseText)); } catch(e) { resolve(null); } }
              else resolve(null);
            };
            xhr.onerror = function() { resolve(null); };
            xhr.send();
          });
          _lockDbg.getOk = !!draft;
          if (!draft) return _lockDbg;

          var putBody = {};
          Object.keys(draft).forEach(function(k) {
            if (draft[k] && typeof draft[k] === 'object' && !Array.isArray(draft[k])) {
              Object.assign(putBody, draft[k]);
            }
          });
          if (!('categories' in putBody) && putBody.formatItems) putBody.categories = putBody.formatItems;
          if (!('formatOptions' in putBody)) {
            var dOpts = putBody.displayOptions || {};
            var pConf = putBody.proposalDisplayConfig || {};
            putBody.formatOptions = {
              body: dOpts.body, header: dOpts.header, printoutType: dOpts.printoutType,
              includeSpecs: dOpts.includeSpecs || false, showAddress: putBody.showAddress || false,
              showOwnerContactInfo: putBody.showOwnerContactInfo || false, showPrintoutInfo: putBody.showPrintoutInfo || false,
              proposalLayout: pConf.proposalLayout != null ? pConf.proposalLayout : 0,
              hasSingleSelectCostTypes: pConf.hasSingleSelectCostTypes || false
            };
          }
          if (Array.isArray(putBody.categories)) {
            putBody.categories.forEach(function(cat) { if (cat.items && !cat.lineItems) { cat.lineItems = cat.items; delete cat.items; } });
          }
          putBody.requireSignatures = false;
          putBody.requiredSignatureUsers = [];
          if (putBody.columnsToDisplay && Array.isArray(putBody.columnsToDisplay.value)) putBody.columnsToDisplay = putBody.columnsToDisplay.value;
          putBody.introductionText = introHtml;
          putBody.closingText = closingHtml;
          var bodyStr = JSON.stringify(putBody);

          var xhrStatus = await new Promise(function(resolve) {
            var xhr = new XMLHttpRequest();
            xhr.open('PUT', '/apix/v2/Proposals/draft?jobId=' + jobId, true);
            xhr.setRequestHeader('content-type', 'application/merge-patch+json');
            xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
            xhr.setRequestHeader('portaltype', '1');
            xhr.onload = function() { resolve(xhr.status); };
            xhr.onerror = function() { resolve(0); };
            xhr.send(bodyStr);
          });
          _lockDbg.putStatus = xhrStatus;
          await delay(800);

          var vxhr = new XMLHttpRequest();
          vxhr.open('GET', '/apix/v2/Proposals/draft?jobId=' + jobId, false);
          vxhr.setRequestHeader('accept', 'application/json, text/plain, */*');
          vxhr.setRequestHeader('portaltype', '1');
          vxhr.send();
          if (vxhr.status === 200) {
            try {
              var vd = JSON.parse(vxhr.responseText);
              var vIntro = (vd.proposal && vd.proposal.introductionText) || '';
              _lockDbg.verifyLen = vIntro.length;
            } catch(e) {}
          }
          return _lockDbg;
        },
        args: [_introHtml, _closingHtml, slowConnection]
      });
      var _lockDbgResult = _lockResult && _lockResult[0] && _lockResult[0].result;
      log('Lock result: ' + JSON.stringify(_lockDbgResult));

      // The proposal page's React app still holds the pre-save proposal object
      // in memory (fetched when "Build Proposal" was first clicked, before our
      // PUT ever ran). Reload — focusing the tab first so the reload isn't
      // throttled in the background — so BT re-fetches fresh data (including
      // what we just saved) before we switch to the Client Preview tab.
      log('Reloading proposal page to sync saved text…');
      setStatus('Reloading proposal page…');
      await chrome.tabs.update(tabId, { active: true });
      await delay(200);
      await chrome.tabs.reload(tabId);
      await new Promise(function (resolve) {
        function checkStatus() {
          chrome.tabs.get(tabId, function (t) {
            if (t && t.status === 'complete') { resolve(); } else { setTimeout(checkStatus, slowConnection ? 600 : 300); }
          });
        }
        setTimeout(checkStatus, slowConnection ? 1600 : 800);
      });
      await delay(2500);
    }

    // Step 2: Click Client Preview tab
    log('Navigating to client preview…');
    var previewResult = await chrome.scripting.executeScript({
      target: { tabId: tabId }, world: 'MAIN',
      func: async function(slowConnection) {
        function delay(ms) { return new Promise(function(r){ setTimeout(r, slowConnection ? ms * 2 : ms); }); }
        function waitFor(fn, ms) {
          return new Promise(function(res, rej) {
            var budget = ms || 6000;
            if (slowConnection) budget *= 2;
            var end = Date.now() + budget;
            (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, slowConnection ? 300 : 150); })();
          });
        }
        var tabEl = await waitFor(function() {
          var el = document.querySelector('[data-testid="jobProposalClientPreviewTab"]');
          return (el && el.offsetParent !== null) ? el : null;
        }, 6000).catch(function(){ return null; });
        if (!tabEl) return { ok: false, error: 'Client Preview tab not found' };
        tabEl.click();
        return { ok: true };
      },
      args: [slowConnection]
    });
    var pr = previewResult && previewResult[0] && previewResult[0].result;
    if (pr && !pr.ok) throw new Error(pr.error || 'Could not open client preview');
    await delay(2000);

    // Step 3: Edit Display to client — remove Cost code, Parent group price, Unit price; add Item title, Description
    log('Configuring display settings…');
    setStatus('Setting display…');
    await chrome.scripting.executeScript({
      target: { tabId: tabId }, world: 'MAIN',
      func: async function(slowConnection) {
        function delay(ms) { return new Promise(function(r){ setTimeout(r, slowConnection ? ms * 2 : ms); }); }
        function waitFor(fn, ms) {
          return new Promise(function(res, rej) {
            var budget = ms || 5000;
            if (slowConnection) budget *= 2;
            var end = Date.now() + budget;
            (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, slowConnection ? 300 : 150); })();
          });
        }

        function removeTag(label) {
          var norm = label.trim().toLowerCase();
          var items = Array.from(document.querySelectorAll('.ant-select-selection-item'));
          var item = items.find(function(el) {
            var c = el.querySelector('.ant-select-selection-item-content');
            return c && c.textContent.trim().toLowerCase() === norm;
          });
          if (item) {
            var btn = item.querySelector('.ant-select-selection-item-remove');
            if (btn) { btn.click(); return true; }
          }
          return false;
        }

        async function addOption(label) {
          var input = document.querySelector('#columnsToDisplay');
          if (!input) return;
          input.focus(); input.click();
          await delay(400);
          var node = await waitFor(function() {
            return Array.from(document.querySelectorAll('.ant-select-tree-node-content-wrapper')).find(function(n) {
              return (n.getAttribute('title') || n.textContent || '').trim().toLowerCase() === label.toLowerCase();
            });
          }, 4000).catch(function(){ return null; });
          if (node) { node.click(); await delay(300); }
          document.body.click();
          await delay(200);
        }

        removeTag('Cost code');    await delay(200);
        removeTag('Parent group price'); await delay(200);
        removeTag('Unit price');   await delay(200);

        var existing = Array.from(document.querySelectorAll('.ant-select-selection-item-content')).map(function(el){ return el.textContent.trim().toLowerCase(); });
        if (!existing.includes('item title'))   await addOption('Item title');
        if (!existing.includes('description'))  await addOption('Description');
      },
      args: [slowConnection]
    });
    await delay(1000);

    // Step 4: Collapse all groups EXCEPT Selection Allowance & Site Allowance
    log('Configuring groups…');
    setStatus('Configuring groups…');
    await chrome.scripting.executeScript({
      target: { tabId: tabId }, world: 'MAIN',
      func: async function(estLenderQty, estCustomItems, slowConnection) {
        function delay(ms) { return new Promise(function(r){ setTimeout(r, slowConnection ? ms * 2 : ms); }); }
        function parseGroupName(raw) {
          var m = raw.match(/^(.*?)\s*\((\d+)\)\s*$/);
          return m ? { name: m[1].trim(), count: parseInt(m[2], 10) } : { name: raw, count: 0 };
        }
        async function groupHasRealItems(panelEl) {
          var wasCollapsed = !panelEl.classList.contains('ant-collapse-item-active');
          if (wasCollapsed) {
            var hdr = panelEl.querySelector('.ant-collapse-header');
            if (hdr) { hdr.click(); await delay(300); }
          }
          var rows = panelEl.querySelectorAll('tr.proposalBaseLineItemContainerRow b');
          var hasReal = false;
          if (rows.length) {
            for (var r = 0; r < rows.length; r++) {
              var t = (rows[r].textContent || '').trim().toLowerCase();
              if (t && !/^place\s*holder$/i.test(t)) { hasReal = true; break; }
            }
          } else {
            // Fallback if the row selector doesn't match this page's markup:
            // strip "Place Holder" occurrences and see if meaningful text remains.
            var txt = (panelEl.textContent || '').replace(/place\s*holder/gi, '').trim();
            hasReal = txt.length > 40;
          }
          return hasReal;
        }

        var KEEP_EXPANDED = ['selection allowances', 'site allowances'];

        // Estimate-grid-based checks (Step 0.5, read before Build Proposal was
        // clicked) — ADDED ON TOP of the rendered-panel-title check below, not
        // a replacement for it. Either signal is enough to force-expand.
        if (estLenderQty && KEEP_EXPANDED.indexOf('preferred lender incentive') === -1) {
          KEEP_EXPANDED.push('preferred lender incentive');
        }
        if (estCustomItems && KEEP_EXPANDED.indexOf('custom selection allowances') === -1) {
          KEEP_EXPANDED.push('custom selection allowances');
        }

        var precheckItems = Array.from(document.querySelectorAll('.ant-collapse-item.ProposalGroup'));
        for (var pi = 0; pi < precheckItems.length; pi++) {
          var nEl = precheckItems[pi].querySelector('h3.ant-typography');
          var raw = nEl ? nEl.textContent.trim().toLowerCase() : '';
          var parsed = parseGroupName(raw);
          if (parsed.count > 0 && parsed.name === 'preferred lender incentive') {
            if (KEEP_EXPANDED.indexOf(parsed.name) === -1) KEEP_EXPANDED.push(parsed.name);
          }
          if (parsed.count > 0 && parsed.name === 'custom selection allowances') {
            var hasRealItems = await groupHasRealItems(precheckItems[pi]);
            if (hasRealItems && KEEP_EXPANDED.indexOf(parsed.name) === -1) KEEP_EXPANDED.push(parsed.name);
          }
        }

        var expandedItems = Array.from(document.querySelectorAll('.ant-collapse-item.ProposalGroup.ant-collapse-item-active'));
        for (var i = 0; i < expandedItems.length; i++) {
          var nameEl = expandedItems[i].querySelector('h3.ant-typography');
          var name = nameEl ? nameEl.textContent.trim().toLowerCase() : '';
          var cleanName = parseGroupName(name).name;
          var keep = KEEP_EXPANDED.some(function(k) { return cleanName === k; });
          if (!keep) {
            var header = expandedItems[i].querySelector('.ant-collapse-header');
            if (header) { header.click(); await delay(200); }
          }
        }

        var allItems = Array.from(document.querySelectorAll('.ant-collapse-item.ProposalGroup'));
        for (var j = 0; j < allItems.length; j++) {
          var nameEl2 = allItems[j].querySelector('h3.ant-typography');
          var name2 = nameEl2 ? nameEl2.textContent.trim().toLowerCase() : '';
          var cleanName2 = parseGroupName(name2).name;
          var shouldExpand = KEEP_EXPANDED.some(function(k) { return cleanName2 === k; });
          if (shouldExpand) {
            var isCollapsed = !allItems[j].classList.contains('ant-collapse-item-active');
            if (isCollapsed) {
              var header2 = allItems[j].querySelector('.ant-collapse-header');
              if (header2) { header2.click(); await delay(200); }
            }
          }
        }
      },
      args: [_estFlags.lenderQtyPositive, _estFlags.customHasItems, slowConnection]
    });
    await delay(800);

    log('✓ Client preview setup complete');
    statusEl.className = 'progress-status success';
    statusEl.textContent = '✓ Client preview is ready.';

  } catch (e) {
    log('ERROR: ' + e.message);
    statusEl.className = 'progress-status error';
    statusEl.textContent = 'Failed: ' + e.message;
  }
}
