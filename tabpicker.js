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
          args: [pendingCustomItems.map(function (i) { return i.name; })],
          func: async function (customItemTitles) {
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

            var diag = [];
            var beforeOrder = groups.map(function (g) { return g.title; });

            // ── Diagnostic: figure out which property on a group object
            // actually holds its child line items (unknown without live
            // data — trying the most likely names). Logged either way so
            // the real shape is visible even if none of these guesses hit.
            var ITEMS_KEY_CANDIDATES = ['items', 'lineItems', 'formatItems', 'proposalFormatItems', 'lineItemDataSet', 'children'];
            var itemsKey = null;
            for (var gk = 0; gk < groups.length && !itemsKey; gk++) {
              for (var ck = 0; ck < ITEMS_KEY_CANDIDATES.length; ck++) {
                if (Array.isArray(groups[gk][ITEMS_KEY_CANDIDATES[ck]]) && groups[gk][ITEMS_KEY_CANDIDATES[ck]].length) {
                  itemsKey = ITEMS_KEY_CANDIDATES[ck];
                  break;
                }
              }
            }
            diag.push('groups: ' + groups.map(function (g) { return '"' + g.title + '" (keys: ' + Object.keys(g).join(',') + ')'; }).join(' | '));
            diag.push('detected items-array key: ' + (itemsKey || '(none matched — see raw group below)'));
            if (!itemsKey) {
              try { diag.push('first group raw (truncated 1500 chars): ' + JSON.stringify(groups[0]).slice(0, 1500)); }
              catch (eJ) { diag.push('first group could not be JSON-stringified: ' + eJ.message); }
            }

            // ── Move any items sitting under the wrong group into the
            // group they actually belong to, directly in this same state
            // update — bypassing the unreliable dropdown/panel UI entirely
            // (same trick, reused for two different item sets below).
            var moves = [];
            function moveItemsIntoGroup(titles, targetGroupTitle) {
              if (!itemsKey || !titles || !titles.length) return;
              var targetIdx = groups.findIndex(function (g) { return norm(g.title) === norm(targetGroupTitle); });
              if (targetIdx === -1) {
                diag.push('"' + targetGroupTitle + '" group not found by title — cannot move anything into it');
                return;
              }
              var wantedTitles = titles.map(function (t) { return norm(t); });
              var newTargetItems = groups[targetIdx][itemsKey].slice();
              for (var gi = 0; gi < groups.length; gi++) {
                if (gi === targetIdx) continue;
                var arr = groups[gi][itemsKey];
                if (!Array.isArray(arr) || !arr.length) continue;
                var keep = [];
                for (var ii = 0; ii < arr.length; ii++) {
                  var it = arr[ii];
                  var itTitle = (it.title || it.name || it.itemTitle || '').trim();
                  if (wantedTitles.indexOf(norm(itTitle)) !== -1) {
                    newTargetItems.push(it);
                    moves.push(itTitle + ': "' + groups[gi].title + '" → "' + targetGroupTitle + '"');
                  } else {
                    keep.push(it);
                  }
                }
                if (keep.length !== arr.length) {
                  groups[gi] = Object.assign({}, groups[gi]);
                  groups[gi][itemsKey] = keep;
                }
              }
              groups[targetIdx] = Object.assign({}, groups[targetIdx]);
              groups[targetIdx][itemsKey] = newTargetItems;
            }

            // Sewer/Water site options — createSiteItem's own parentId field
            // never reliably appears during creation (see comment there).
            moveItemsIntoGroup([
              'Sewer - City (No Septic)', 'Sewer - Conventional Septic', 'Sewer - Engineered Septic',
              'Water - Well'
            ], 'Site Allowances');

            // This write's own custom allowance items (editGroupPlaceHolder/
            // createLineItem) — titles are whatever the user typed, passed in
            // from tabpicker.js's pendingCustomItems, not a fixed list like
            // the site options above.
            moveItemsIntoGroup(customItemTitles, 'Custom Selection Allowances');

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

            var afterOrder = ordered.map(function (g) { return g.title; });

            // Call BT's own handler — it handles auth, API format, everything
            await targetNode.memoizedProps.onUpdateProposalFormatItems(ordered);

            return { ok: true, diag: diag, moves: moves, beforeOrder: beforeOrder, afterOrder: afterOrder };
          }
        });

        var rr = reorderResult && reorderResult[0] && reorderResult[0].result;
        if (rr && !rr.ok) {
          log('⚠ Reorder: ' + (rr.error || 'unknown error'));
          statusEl.className = 'progress-status success';
          statusEl.textContent = '✓ Wrote ' + res2.ok + ' item(s) — group reorder failed (see log).';
        } else {
          if (rr) {
            log('  Group order before: ' + (rr.beforeOrder || []).join(' → '));
            log('  Group order after:  ' + (rr.afterOrder || []).join(' → '));
            (rr.diag || []).forEach(function (d) { log('  🔍 ' + d); });
            if (rr.moves && rr.moves.length) {
              rr.moves.forEach(function (m) { log('  ✓ Moved: ' + m); });
            } else {
              log('  (no site-allowance items needed moving this time)');
            }
          }
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

    // One-shot diagnostic — fires the first time ANY title/cost/markup
    // field search fails, even after widened waits. If BuilderTrend's UI
    // genuinely changed (new popup/modal, renamed data-testid attributes),
    // widening a wait can never fix it — this dumps what's ACTUALLY on the
    // page right now so the real selectors can be identified from real
    // data, same approach that found the parent-group/cost-code bugs
    // earlier. Logged once so it doesn't repeat for every failed item.
    var _uiShapeDiagnosticLogged = false;
    function logUiShapeDiagnosticOnce(context) {
      if (_uiShapeDiagnosticLogged) return;
      _uiShapeDiagnosticLogged = true;
      try {
        var modalLike = document.querySelectorAll('.ant-modal, [role="dialog"], .ant-drawer, .ant-drawer-content');
        _log.push('🔍 UI DIAGNOSTIC (' + context + '): modal/dialog/drawer-like containers found = ' + modalLike.length);
        for (var m = 0; m < Math.min(modalLike.length, 3); m++) {
          _log.push('🔍 UI DIAGNOSTIC[' + m + '] tag=' + modalLike[m].tagName + ' class="' + modalLike[m].className + '"');
          _log.push('🔍 UI DIAGNOSTIC[' + m + '] outerHTML (first 1200 chars): ' + modalLike[m].outerHTML.slice(0, 1200));
        }
        // Not just input[] — the title field is a <textarea>, which is
        // exactly the tag-restriction bug that caused the original problem
        // this diagnostic exists to catch. No tag restriction this time.
        var fuzzy = document.querySelectorAll(
          '[data-testid*="itle" i], [data-testid*="ost" i], [data-testid*="arkup" i], [data-testid*="uantity" i], ' +
          '[id*="itle" i], [id*="ost" i]'
        );
        _log.push('🔍 UI DIAGNOSTIC (' + context + '): fuzzy title/cost/markup/quantity fields found anywhere on page (any tag) = ' + fuzzy.length);
        var seen = [];
        for (var f = 0; f < fuzzy.length; f++) {
          seen.push('id="' + fuzzy[f].id + '" data-testid="' + (fuzzy[f].getAttribute('data-testid') || '') + '" value="' + fuzzy[f].value + '" visible=' + !!fuzzy[f].offsetHeight);
        }
        _log.push('🔍 UI DIAGNOSTIC fuzzy input list: ' + (seen.length ? seen.join(' | ') : '(none found at all)'));
      } catch (eDiag) {
        _log.push('🔍 UI DIAGNOSTIC failed: ' + eDiag.message);
      }
    }

    function reactSet(input, val) {
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(val));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Types a number into an Ant Design InputNumber-style spinbutton
    // (quantity, unit cost) one character at a time with real keydown/
    // keypress/keyup events — extracted from setQty, which already relied
    // on exactly this. A plain native-setter + single "input" event (like
    // writeReactValue uses for plain text fields) isn't enough for these
    // controlled numeric fields to register the value correctly.
    async function typeNumericValue(inputEl, numValue) {
      inputEl.focus();
      await _delay(150);
      inputEl.select();
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, ctrlKey: true, bubbles: true }));
      await _delay(50);
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', keyCode: 46, bubbles: true }));
      reactSet(inputEl, '');
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      await _delay(100);

      var rounded = Math.round(numValue * 100) / 100;
      var valStr = String(rounded);
      var setter2 = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (var ci = 0; ci < valStr.length; ci++) {
        var ch = valStr[ci];
        var code = ch.charCodeAt(0);
        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: ch, keyCode: code, bubbles: true }));
        inputEl.dispatchEvent(new KeyboardEvent('keypress', { key: ch, keyCode: code, bubbles: true }));
        setter2.call(inputEl, valStr.slice(0, ci + 1));
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: ch, keyCode: code, bubbles: true }));
        await _delay(20);
      }
      await _delay(200);
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

    // BuilderTrend replaced its old modal/drawer item editor with ONE
    // unified panel (.bui-splitview-panel > div.WorksheetDetailPanel) used
    // for every scenario — editing an existing item, editing a Place
    // Holder, and creating a new item (custom or site) all open this same
    // panel, just pre-filled differently. All its fields are FLAT ids, not
    // namespaced per-row like the old "formatItems[4].items[0].unitCost"
    // pattern createLineItem/createSiteItem used to rely on. Confirmed live
    // (2026-09-11):
    //   title       <textarea id/data-testid/name="itemTitle">  (NOT input — this
    //               alone broke every old input[data-testid="itemTitle"] selector)
    //   cost code   input#costCodeId          (ant-select search input)
    //   parent grp  input#parentId            (ant-select search input; picking a
    //               cost code does NOT set this — it's independent)
    //   quantity    input[data-testid="quantity"] (no id)
    //   unit cost   input#unitCost / [data-testid="unitCost"]
    //   markup      input#markupValue / [data-testid="Markup.markupPercent"]
    //   description input#description / [data-testid="description"]
    //   save button button[data-testid="lineitemdetails-panel-save"] — a real,
    //               directly-clickable button. Replaces the old "click near the
    //               sidebar to trigger a dirty-tracking popup, then click
    //               [data-testid=dirtyTrackingSave]" two-step hack entirely.
    //
    // fields: { title, description, costCode, parentGroup, quantity, unitCost, markupPercent }
    // — pass only the ones you want to set; each is independently optional.
    async function fillPanelFields(fields, contextLabel) {
      var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

      async function pickAntSelect(el, text, label) {
        var wrap = el.closest('.ant-select') || el.parentElement;
        if (wrap) { wrap.click(); await _delay(300); }
        el.focus(); await _delay(100);
        ns.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await _delay(900);
        var opts = document.querySelectorAll('.ant-select-item-option-content');
        var opt = null;
        for (var i = 0; i < opts.length; i++) {
          if ((opts[i].textContent || '').trim() === text) { opt = opts[i]; break; }
        }
        if (opt) {
          opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          opt.click();
          await _delay(400);
          return true;
        }
        _log.push('⚠ ' + contextLabel + ': "' + text + '" option not found for ' + label + ' — continuing');
        return false;
      }

      if (fields.title !== undefined && fields.title !== null) {
        var titleEl = document.getElementById('itemTitle') || document.querySelector('[data-testid="itemTitle"]');
        if (titleEl) { writeReactValue(titleEl, fields.title); await _delay(250); }
        else { _log.push('⚠ ' + contextLabel + ': title field not found'); logUiShapeDiagnosticOnce(contextLabel + ' title'); }
      }

      if (fields.costCode) {
        var ccEl = document.getElementById('costCodeId');
        if (ccEl) { await pickAntSelect(ccEl, fields.costCode, 'cost code'); }
        else { _log.push('⚠ ' + contextLabel + ': cost code field not found'); }
      }

      if (fields.parentGroup) {
        var pgEl = document.getElementById('parentId');
        if (pgEl) {
          var pgWrap = pgEl.closest('.ant-select') || pgEl.parentElement;
          var pgAlready = pgWrap && pgWrap.querySelector('.ant-select-selection-item');
          var pgAlreadyText = pgAlready ? (pgAlready.textContent || '').trim() : '';
          if (pgAlreadyText === fields.parentGroup) {
            _log.push('✓ ' + contextLabel + ': parent group already "' + fields.parentGroup + '" — leaving as-is');
          } else {
            await pickAntSelect(pgEl, fields.parentGroup, 'parent group');
          }
        } else {
          _log.push('⚠ ' + contextLabel + ': parent group field not found');
        }
      }

      if (fields.quantity !== undefined && fields.quantity !== null) {
        var qtyEl = document.querySelector('input[data-testid="quantity"]') || document.querySelector('input[name="quantity"]');
        if (qtyEl) { await typeNumericValue(qtyEl, fields.quantity); }
        else { _log.push('⚠ ' + contextLabel + ': quantity field not found'); logUiShapeDiagnosticOnce(contextLabel + ' quantity'); }
      }

      if (fields.unitCost !== undefined && fields.unitCost !== null) {
        var ucEl = document.getElementById('unitCost') || document.querySelector('input[data-testid="unitCost"]');
        if (ucEl) { await typeNumericValue(ucEl, parseFloat(fields.unitCost)); }
        else { _log.push('⚠ ' + contextLabel + ': unit cost field not found'); logUiShapeDiagnosticOnce(contextLabel + ' unit cost'); }
      }

      if (fields.description) {
        var descEl = document.getElementById('description') || document.querySelector('[data-testid="description"]');
        if (descEl) { writeReactValue(descEl, fields.description); await _delay(200); }
        else { _log.push('⚠ ' + contextLabel + ': description field not found'); }
      }

      if (fields.markupPercent !== null && fields.markupPercent !== undefined) {
        await trySetMarkupPercent(fields.markupPercent, contextLabel);
      }

      var saveBtn = null;
      for (var s = 0; s < 20; s++) {
        saveBtn = document.querySelector('button[data-testid="lineitemdetails-panel-save"]');
        if (saveBtn) break;
        await _delay(150);
      }
      if (saveBtn) {
        saveBtn.click();
        await _delay(900);
        return true;
      }
      _log.push('⚠ ' + contextLabel + ': save button not found — changes may not have persisted');
      logUiShapeDiagnosticOnce(contextLabel + ' save button');
      return false;
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

      // ── Step 4: Wait for the panel's title field to appear ─────────────────
      // Title is now a single flat <textarea id="itemTitle">, reused for
      // every open/close, not a uniquely-numbered per-row element — the old
      // "diff against a pre-open snapshot of itemTitle elements" approach
      // above this always failed after the first item, since the id never
      // changes for the snapshot to differ against. Just wait for it directly.
      var newTitleEl = null;
      for (var a=0; a<30; a++) {
        newTitleEl = document.getElementById('itemTitle') || document.querySelector('[data-testid="itemTitle"]');
        if (newTitleEl) break;
        await _delay(150);
      }
      if (!newTitleEl) { _log.push('✗ createLineItem: new title input not found'); logUiShapeDiagnosticOnce('createLineItem new title'); return; }

      // Everything else — title, description, cost code, parent group, unit
      // cost, markup — lives in the same one panel this new row just opened
      // (confirmed live 2026-09-11: flat ids, not the old namespaced
      // "formatItems[4].items[0].unitCost" pattern), so one call fills
      // every field and saves once via the real save button.
      newTitleEl.scrollIntoView({ behavior:'instant', block:'center' });
      await _delay(200);
      await fillPanelFields({
        title: title,
        description: description || null,
        costCode: 'Custom Selection Allowances',
        parentGroup: 'Custom Selection Allowances',
        unitCost: unitCost,
        markupPercent: markupPercent
      }, 'createLineItem');

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
      // Title is a single flat <textarea id="itemTitle">, reused for every
      // open/close — not a uniquely-numbered per-row element, so (like
      // createLineItem) just wait for it directly instead of diffing
      // against a pre-open snapshot that never actually changes.
      var newTitleEl = null;
      for (var tat=0; tat<70; tat++) {
        newTitleEl = document.getElementById('itemTitle') || document.querySelector('[data-testid="itemTitle"]');
        if (newTitleEl) break;
        await _delay(150);
      }
      if (!newTitleEl) { _log.push('✗ createSiteItem: title input not found'); logUiShapeDiagnosticOnce('createSiteItem title'); return; }

      newTitleEl.scrollIntoView({ behavior:'instant', block:'center' });
      await _delay(200);

      // Step 5: Cost code — type the parent group name (e.g. "06 - Municipal Tap Fees") to
      // find the matching cost code. Cost code field is flat (id="costCodeId"),
      // not namespaced per-row like the old UI — confirmed live 2026-09-11.
      // Kept as its own inline block (not fillPanelFields) because of the
      // fallback-to-"09 - Lot Clearing" behavior below, which fillPanelFields
      // doesn't support.
      var ccInput = document.getElementById('costCodeId');
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
          // Log what was ACTUALLY matched/selected, not the intended
          // parentGroup value — a silent exact-match failure here used to
          // fall through to the "09 - Lot Clearing" fallback while still
          // logging success, making it look like the right code was picked
          // when it wasn't.
          _log.push('✓ createSiteItem: cost code set to "' + ccOpt.textContent.trim() + '"' + (ccOpt.textContent.trim() !== parentGroup ? ' (⚠ intended "' + parentGroup + '" — fallback was used)' : ''));
        } else { _log.push('⚠ createSiteItem: cost code option not found — continuing'); }
      } else {
        _log.push('⚠ createSiteItem: cost code input not found');
      }

      // Title, parent group (the real "Site Allowances" category — cost
      // code selection does NOT set this on its own, confirmed live),
      // unit cost, and markup all live in the same panel; fill them and
      // save once via the real save button.
      await fillPanelFields({
        title: title,
        parentGroup: 'Site Allowances',
        unitCost: (unitCost && parseFloat(unitCost) > 0) ? unitCost : null,
        markupPercent: markupPercent
      }, 'createSiteItem');

      _log.push('✓ Site item: ' + title + ' → Site Allowances' + (unitCost ? ' → $' + unitCost : ''));
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

      // Title, unit cost, description, and markup all live in the same
      // panel this click just opened (confirmed live 2026-09-11 — title is
      // now a flat <textarea id="itemTitle">, not the old <input>, which is
      // why this used to fail even with long waits). One call fills every
      // field and saves once via the real save button.
      await fillPanelFields({
        title: newTitle,
        unitCost: unitCost,
        description: description || null,
        markupPercent: markupPercent
      }, 'editExistingItem: ' + searchName);

      _log.push('✓ editExistingItem: ' + searchName + ' → "' + newTitle + '" $' + unitCost);
    }


    // Combines what used to be 3 separate search→open→save round trips
    // (setQty for quantity, setItemMarkupAndDescription for markup, setQty
    // again for unit cost) into ONE side-panel visit — confirmed live that
    // the quantity spinbutton (data-testid="quantity") is present in the
    // same panel as unit cost and markup, not a different popup. Same
    // search/open-row/open-panel steps as setItemMarkupAndDescription
    // above; qty and unit cost use typeNumericValue (same proven mechanism
    // setQty already used) instead of writeReactValue, since these are
    // Ant Design InputNumber fields, not plain text inputs.
    //
    // isUnitCostFirst preserves setQty's own quirk: for some items the
    // "quantity" value is deliberately written into the unit-cost field
    // instead of the quantity field (see the main loop's existing
    // setQty(...,isUnitCost) call) — same meaning here.
    async function setQtyMarkupUnitCostCombined(name, qty, isUnitCostFirst, unitCost, markupPercent, description) {
      var startTime = performance.now();
      var nsC = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

      // Step 1: Search for item → click LineItemResult (same as setItemMarkupAndDescription)
      var siC = document.getElementById('rc_select_17') || document.getElementById('rc_select_1');
      if (!siC) {
        var candsC = Array.from(document.querySelectorAll('input[role="combobox"].ant-select-selection-search-input'));
        siC = candsC.find(function(el){ var id=el.id||''; return id.startsWith('rc_select_') && id!=='rc_select_0'; });
      }
      if (siC) {
        var contC = siC.closest('.ant-select-selector') || siC.parentElement;
        if (contC) { contC.click(); await _delay(200); }
        siC.focus(); await _delay(100);
        nsC.call(siC, name);
        siC.dispatchEvent(new Event('input',{bubbles:true}));
        siC.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(900);
        var cResult = null;
        var cItems = document.querySelectorAll('.LineItemResult, [class*="LineItem"][class*="Result"]');
        for (var cli=0; cli<cItems.length; cli++) {
          if ((cItems[cli].innerText||'').trim().toLowerCase() === name.toLowerCase()) { cResult = cItems[cli]; break; }
        }
        if (cResult) {
          cResult.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
          cResult.click();
          await _delay(1000);
        }
        nsC.call(siC, '');
        siC.dispatchEvent(new Event('input',{bubbles:true}));
        siC.dispatchEvent(new Event('change',{bubbles:true}));
        await _delay(400);
      }

      // Step 2: Find the row → click it to open the side panel
      var targetRowC = null;
      for (var tdiC=0; tdiC<20; tdiC++) {
        var bTagsC = document.querySelectorAll('tr.proposalBaseLineItemContainerRow b');
        for (var tdi2C=0; tdi2C<bTagsC.length; tdi2C++) {
          if ((bTagsC[tdi2C].textContent||'').trim().toLowerCase() === name.toLowerCase()) {
            targetRowC = bTagsC[tdi2C].closest('tr.proposalBaseLineItemContainerRow');
            break;
          }
        }
        if (targetRowC) break;
        await _delay(150);
      }
      if (!targetRowC) { _log.push('⚠ setQtyMarkupUnitCostCombined: row not found for ' + name); return; }
      targetRowC.click();
      await _delay(800);

      // Step 3: Click the title ValueDisplay to open the panel's edit context
      var titleDisplayC = null;
      for (var tddC=0; tddC<15; tddC++) {
        var tDisplaysC = document.querySelectorAll('.ValueDisplay[data-testid$=".itemTitle"]');
        for (var tdi3C=0; tdi3C<tDisplaysC.length; tdi3C++) {
          if ((tDisplaysC[tdi3C].textContent||'').trim().toLowerCase() === name.toLowerCase()) { titleDisplayC = tDisplaysC[tdi3C]; break; }
        }
        if (titleDisplayC) break;
        await _delay(100);
      }
      if (titleDisplayC) { titleDisplayC.click(); await _delay(400); }
      else { _log.push('⚠ setQtyMarkupUnitCostCombined: title ValueDisplay not found for ' + name); }

      // Quantity is normally its own field; isUnitCostFirst means this
      // particular item's "quantity" value actually belongs in the unit
      // cost field instead (some items are set up that way on purpose —
      // see the main loop's own comment on this flag). Everything —
      // quantity/unit-cost, description, markup, and the second separate
      // unit cost value — lives in the one panel already open; one call
      // fills it all in and saves once via the real save button.
      var qtyResult = qty;
      var ucResult = (!isUnitCostFirst && unitCost !== undefined && unitCost !== null) ? unitCost : null;
      await fillPanelFields({
        quantity: isUnitCostFirst ? null : qty,
        unitCost: isUnitCostFirst ? qty : (ucResult !== null ? ucResult : null),
        description: description || null,
        markupPercent: markupPercent
      }, 'setQtyMarkupUnitCostCombined: ' + name);

      var totalTimeC = performance.now() - startTime;
      _log.push('✓ ' + name +
        (qtyResult !== null ? ' → ' + qtyResult + (isUnitCostFirst ? ' (unit cost)' : ' (qty)') : '') +
        (markupPercent !== null && markupPercent !== undefined ? ' → markup ' + markupPercent + '%' : '') +
        (ucResult !== null ? ' → ' + ucResult + ' (unit cost)' : '') +
        ' (' + totalTimeC.toFixed(0) + 'ms)');
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

      if (description) { _log.push('  └ Writing Place Holder description: "' + description + '"…'); }
      // Title, description, unit cost, and markup all live in the same
      // panel this click just opened; one call fills every field and
      // saves once via the real save button.
      await fillPanelFields({
        title: newTitle,
        description: description || null,
        unitCost: unitCost,
        markupPercent: markupPercent
      }, 'editGroupPlaceHolder: ' + groupTitle);

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
        // Markup applies to every item now (not just ones with a tier
        // description). EXCEPT Realtor Fees: its Unit Cost is a real
        // market rate straight from the SALES TO EDIT - REALTOR cost_items
        // row, not a total that already has markup baked into every other
        // line, but it's still kept at 0% by deliberate choice (unchanged
        // from before) — see fetchUnitCostsFromSupabase/
        // QUANTITY_ITEM_NAME_TO_COST_ITEM_NAME in popup.js for how its
        // qty/unitCost actually get resolved now.
        var itemMarkupPercent = (itemsList[i].name === 'Realtor Fees') ? 0 : markupPercent;
        // Confirmed live (2026-09-04): the quantity spinbutton, unit cost
        // input, and markup field are all reachable from the SAME side
        // panel — one open→fill→save now replaces what used to be 3
        // separate search/open/save round trips (setQty for qty,
        // setItemMarkupAndDescription for markup, setQty again for unit
        // cost). Supabase-sourced unit cost is still only set when the
        // caller actually resolved one (no match in cost_items =>
        // undefined => left alone, never guessed or zeroed).
        var itemUnitCost = (itemsList[i].unitCost !== undefined && itemsList[i].unitCost !== null) ? itemsList[i].unitCost : null;
        await setQtyMarkupUnitCostCombined(itemsList[i].name, itemsList[i].qty, itemsList[i].isUnitCost, itemUnitCost, itemMarkupPercent, itemsList[i].description);
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
