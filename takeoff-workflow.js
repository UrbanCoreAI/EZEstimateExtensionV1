// Duke Estimating — Guided Takeoff Workflow
// Runs in the panel context alongside popup.js
// Requires: $(), showStatus(), sendMsg(), grabTakeoff(), writeValues() from popup.js

(function () {
  'use strict';

  // ── Workflow Data ─────────────────────────────────────────────────────────────

  var COUNT_ITEMS = [
    { label: 'Exterior Doors',  msg: 'Click each exterior door on the plan, then press Enter or Done' },
    { label: 'Interior Doors',  msg: 'Click each interior door on the plan, then press Enter or Done' },
    { label: 'Windows',         msg: 'Click each window on the plan, then press Enter or Done' },
    { label: 'Porch Columns',   msg: 'Click each porch column on the plan, then press Enter or Done' },
    { label: 'Staircases',      msg: 'Click each staircase on the plan, then press Enter or Done' },
    { label: 'Garage Doors',    msg: 'Click each garage door on the plan, then press Enter or Done' },
    { label: 'Baths',           msg: 'Click each bathroom on the plan, then press Enter or Done\n(Decimals like 3.5 can be adjusted in takeoff after all counts)' },
  ];

  // Build per-floor area item lists from user config.
  // floorPageIndex = 0-based index into wf.floors (the actual detected floor pages).
  // cfg = { floors: 1|2|3, rearPorch, rearDeck, basement, atticStorage, habitableAttic }
  // totalPages = wf.floors.length (actual detected floor pages).
  // Attic items always go on the LAST floor page regardless of cfg.floors.
  function areaItemsForFloorPage(floorPageIndex, cfg, totalPages) {
    var base1st = ['1st Floor'];
    if (cfg.hasGarage !== false) base1st.push('Garage');
    base1st.push('Front Porch');
    if (cfg.rearPorch)  base1st.push('Rear Porch');
    if (cfg.rearDeck)   base1st.push('Rear Deck');
    if (cfg.basement)   base1st.push('Basement');

    var attic = [];
    if (cfg.atticStorage)   attic.push('Attic with Storage');
    if (cfg.habitableAttic) attic.push('Habitable Attic');

    var total = totalPages || 1;
    var isTopFloor = floorPageIndex === total - 1;

    if (total === 1) return base1st.concat(attic);
    if (floorPageIndex === 0) return base1st;
    var floorNum = floorPageIndex + 1;
    var floorLabel = floorNum === 2 ? '2nd Floor' : floorNum === 3 ? '3rd Floor' : floorNum + 'th Floor';
    return [floorLabel].concat(isTopFloor ? attic : []);
  }

  function playNotifChime() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      [[523, 0], [659, 0.15], [784, 0.3]].forEach(function (note) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = note[0];
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.4, ctx.currentTime + note[1]);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + note[1] + 0.4);
        osc.start(ctx.currentTime + note[1]);
        osc.stop(ctx.currentTime + note[1] + 0.4);
      });
    } catch (e) {}
  }

  // Show the specs page picker and return array of selected 0-based indices.
  // Returns empty array if user clicks No Specs.
  function selectSpecsPages(names) {
    return new Promise(function (resolve) {
      var picker   = document.getElementById('tk-specs-picker');
      var list     = document.getElementById('tk-specs-list');
      var noneBtn  = document.getElementById('btn-specs-none');
      var confBtn  = document.getElementById('btn-specs-confirm');
      if (!picker || !list || !noneBtn || !confBtn) { resolve([]); return; }

      // Build checkboxes for every sheet
      list.innerHTML = '';
      names.forEach(function (name, idx) {
        var lbl = document.createElement('label');
        lbl.innerHTML = '<input type="checkbox" value="' + idx + '"> ' + name;
        list.appendChild(lbl);
      });

      picker.classList.remove('hidden');
      playNotifChime();
      chrome.runtime.sendMessage({ action: 'FOCUS_PANEL' });

      function cleanup() {
        picker.classList.add('hidden');
        noneBtn.removeEventListener('click', onNone);
        confBtn.removeEventListener('click', onConfirm);
        document.removeEventListener('keydown', onKey);
      }
      function onNone() { cleanup(); resolve([]); }
      function onConfirm() {
        var selected = Array.from(list.querySelectorAll('input[type="checkbox"]:checked'))
          .map(function (cb) { return parseInt(cb.value, 10); });
        cleanup();
        resolve(selected);
      }
      function onKey(e) {
        if (e.key === 'Enter' && !e.ctrlKey) { e.preventDefault(); onConfirm(); }
      }
      noneBtn.addEventListener('click', onNone);
      confBtn.addEventListener('click', onConfirm);
      document.addEventListener('keydown', onKey);
    });
  }

  // Render extracted flooring notes above the area config dialog.
  // Strips from "flooring" any note already in hardwood/tile/carpet.
  function renderFlooringNotes(notes) {
    var box = document.getElementById('tk-flooring-notes');
    var body = document.getElementById('tk-flooring-notes-body');
    if (!box || !body || !notes) return;
    function norm(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
    var specific = new Set(
      (notes.hardwood || []).concat(notes.tile || []).concat(notes.carpet || []).map(norm)
    );
    var uniqueFlooring = (notes.flooring || []).filter(function (n) { return !specific.has(norm(n)); });
    var sections = [
      { title: 'Hardwood', items: notes.hardwood || [] },
      { title: 'Carpet',   items: notes.carpet   || [] },
      { title: 'Tile',     items: notes.tile      || [] },
      { title: 'Flooring', items: uniqueFlooring        },
    ].filter(function (s) { return s.items.length > 0; });
    if (!sections.length) return;
    body.innerHTML = sections.map(function (s) {
      return '<div class="fn-section"><div class="fn-section-title">' + s.title + '</div>' +
        s.items.map(function (n) { return '<div class="fn-note">• ' + n + '</div>'; }).join('') +
        '</div>';
    }).join('');
    box.classList.remove('hidden');
    box.open = true;
  }

  // Show the area config dialog and return a promise that resolves with the cfg object.
  // flooringNotes = { hardwood:[], carpet:[], tile:[], flooring:[] } from GPT extraction (optional)
  function collectAreaConfig(flooringNotes) {
    return new Promise(function (resolve) {
      var dialog = document.getElementById('tk-area-config');
      var confirmBtn = document.getElementById('btn-ac-confirm');
      var floorsRow = document.getElementById('ac-floors-row');
      var flooringContainer = document.getElementById('ac-flooring-floors');

      if (floorsRow) floorsRow.style.display = (wf.floors.length === 1) ? '' : 'none';

      var numFloors = wf.floors.length > 1 ? wf.floors.length : 1;

      // Determine which floor index a note belongs to (returns array of 0-based indices)
      function floorsForNote(text) {
        var t = (text || '').toLowerCase();
        var found = [];
        if (/1st\s*floor|first\s*floor|kitchen/i.test(t)) found.push(0);
        if (/2nd\s*floor|second\s*floor/i.test(t)) found.push(1);
        if (/3rd\s*floor|third\s*floor/i.test(t))  found.push(2);
        return found;
      }

      // Build per-floor flooring checkboxes then auto-select from notes
      function rebuildFlooringSection(count) {
        flooringContainer.innerHTML = '';
        for (var fi = 0; fi < count; fi++) {
          var lbl = wf.floors[fi] ? wf.floors[fi].label : ('Floor ' + (fi + 1));
          var div = document.createElement('div');
          div.style.marginBottom = '4px';
          div.innerHTML = '<strong style="font-size:11px">' + lbl + ':</strong> ' +
            '<label style="margin-right:6px"><input type="checkbox" id="ac-floor-' + fi + '-hardwood"> Hardwood</label>' +
            '<label style="margin-right:6px"><input type="checkbox" id="ac-floor-' + fi + '-carpet"> Carpet</label>' +
            '<label><input type="checkbox" id="ac-floor-' + fi + '-tile"> Tile</label>';
          flooringContainer.appendChild(div);
        }
        applyAutoFlooring(count);
      }

      function applyAutoFlooring(count) {
        if (!flooringNotes) return;
        var cats = { hardwood: 'hardwood', carpet: 'carpet', tile: 'tile' };
        Object.keys(cats).forEach(function (cat) {
          var notes = flooringNotes[cat] || [];
          if (!notes.length) return;
          if (count === 1) {
            // Single page — check this type on the only floor set
            var cb = document.getElementById('ac-floor-0-' + cat);
            if (cb) cb.checked = true;
          } else {
            notes.forEach(function (note) {
              var floorIdxs = floorsForNote(note);
              if (!floorIdxs.length) {
                // No floor keyword → apply to all floors
                for (var i = 0; i < count; i++) {
                  var cb2 = document.getElementById('ac-floor-' + i + '-' + cat);
                  if (cb2) cb2.checked = true;
                }
              } else {
                floorIdxs.forEach(function (idx) {
                  if (idx < count) {
                    var cb3 = document.getElementById('ac-floor-' + idx + '-' + cat);
                    if (cb3) cb3.checked = true;
                  }
                });
              }
            });
          }
        });
      }

      rebuildFlooringSection(numFloors);

      // If single-page, re-apply auto-selection when floor count radio changes
      if (wf.floors.length === 1) {
        var radios = document.querySelectorAll('input[name="ac-floors"]');
        radios.forEach(function (r) {
          r.addEventListener('change', function () {
            var n = parseInt(r.value, 10);
            rebuildFlooringSection(n);
          });
        });
      }

      // Show "no specs found" notice if extraction was skipped
      var noSpecsEl = document.getElementById('tk-no-specs-msg');
      if (noSpecsEl) noSpecsEl.style.display = flooringNotes ? 'none' : '';

      dialog.classList.remove('hidden');
      playNotifChime();

      function onConfirm() {
        confirmBtn.removeEventListener('click', onConfirm);
        document.removeEventListener('keydown', onEnter);
        var floorsVal = (wf.floors.length > 1)
          ? wf.floors.length
          : parseInt((document.querySelector('input[name="ac-floors"]:checked') || { value: '1' }).value, 10);

        var flooringPerFloor = [];
        for (var i = 0; i < floorsVal; i++) {
          var items = [];
          if (document.getElementById('ac-floor-' + i + '-hardwood') && document.getElementById('ac-floor-' + i + '-hardwood').checked) items.push('Hardwood');
          if (document.getElementById('ac-floor-' + i + '-carpet')   && document.getElementById('ac-floor-' + i + '-carpet').checked)   items.push('Carpet');
          if (document.getElementById('ac-floor-' + i + '-tile')     && document.getElementById('ac-floor-' + i + '-tile').checked)     items.push('Tile');
          flooringPerFloor.push(items);
        }

        var cfg = {
          floors:           floorsVal,
          rearPorch:        document.getElementById('ac-rear-porch').checked,
          rearDeck:         document.getElementById('ac-rear-deck').checked,
          basement:         document.getElementById('ac-basement').checked,
          atticStorage:     document.getElementById('ac-attic-storage').checked,
          habitableAttic:   document.getElementById('ac-habitable-attic').checked,
          flooringPerFloor: flooringPerFloor,
        };
        dialog.classList.add('hidden');
        resolve(cfg);
      }

      function onEnter(e) {
        if (e.key === 'Enter') onConfirm();
      }

      confirmBtn.addEventListener('click', onConfirm);
      document.addEventListener('keydown', onEnter);
    });
  }

  var LINEAR_ITEMS = ['Cabinets', 'Countertops'];

  // ── State ─────────────────────────────────────────────────────────────────────

  var wf = {
    active:               false,
    stTabId:              null,
    floors:               [],
    scales:               {},
    userResolve:          null,  // resolves with 'done' | 'skip' | 'cancel'
    skipResolve:          null,  // resolves automated steps when user hits Skip
    totalSteps:           1,
    currentStep:          0,
    allowEnterForEstimate: false, // true only during the post-write-to-sheet estimate step
    seqStep:              0,     // current position in final 3-step sequence (0=Grab&Write, 1=WriteToEstimate, 2=ClientPreview, 3=done)
    seqMaxStep:           -1,    // highest step reached; -1 = sequence not started yet
  };

  // Returns a promise that resolves with 'skip' when the user presses Skip during automation
  function waitForSkip() {
    return new Promise(function (res) { wf.skipResolve = res; });
  }
  function clearSkip() { wf.skipResolve = null; }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function tkLog(msg) {
    var log = document.getElementById('tk-log');
    if (!log) return;
    log.textContent += msg + '\n';
    log.scrollTop = log.scrollHeight;
  }

  function tkSet(icon, title, msg, showDone, showSkip) {
    var el = function (id) { return document.getElementById(id); };
    if (el('tk-card-icon'))  el('tk-card-icon').textContent  = icon  || '⏳';
    if (el('tk-card-title')) el('tk-card-title').textContent = title || '';
    if (el('tk-card-msg'))   el('tk-card-msg').textContent   = msg   || '';
    var doneBtn = el('btn-tk-done');
    var skipBtn = el('btn-tk-skip');
    if (doneBtn) doneBtn.classList.toggle('hidden', !showDone);
    // Skip is always visible while the workflow is running
    if (skipBtn) skipBtn.classList.toggle('hidden', false);
    // Always hide Yes/No when tkSet is called (they're managed by tkAskYesNo)
    var yesBtn2 = el('btn-tk-yes'); var noBtn2 = el('btn-tk-no');
    if (yesBtn2) yesBtn2.classList.add('hidden');
    if (noBtn2)  noBtn2.classList.add('hidden');
  }

  function tkProgress(step, total) {
    wf.currentStep = step;
    wf.totalSteps  = total;
    var info = document.getElementById('tk-step-info');
    var bar  = document.getElementById('tk-progress');
    if (info) info.textContent = 'Step ' + step + ' of ' + total;
    if (bar)  bar.style.width  = Math.round(step / total * 100) + '%';
  }

  // Send a message to the SquareTakeoff content script
  function stMsg(action, data) {
    if (!wf.stTabId) return Promise.reject(new Error('No SquareTakeoff tab'));
    return new Promise(function (resolve, reject) {
      // frameId: 0 = main frame only — prevents the svgedit iframe's content script from responding
      chrome.tabs.sendMessage(wf.stTabId, Object.assign({ action: action }, data || {}), { frameId: 0 }, function (res) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message)); return;
        }
        if (!res) { reject(new Error('No response from tab')); return; }
        if (!res.ok) { reject(new Error(res.error || 'Action failed')); return; }
        resolve(res);
      });
    });
  }

  // Wait for user to click Done, Skip, or Cancel — or a floor-label button
  function waitForUser() {
    return new Promise(function (resolve) { wf.userResolve = resolve; });
  }

  // Show Yes/No buttons and ask a question — resolves with true (Yes) or false (No).
  // Enter key = Yes.
  function tkAskYesNo(icon, title, msg) {
    return new Promise(function (resolve) {
      var el = function (id) { return document.getElementById(id); };
      if (el('tk-card-icon'))  el('tk-card-icon').textContent  = icon  || '❓';
      if (el('tk-card-title')) el('tk-card-title').textContent = title || '';
      if (el('tk-card-msg'))   el('tk-card-msg').textContent   = msg   || '';
      var yesBtn  = el('btn-tk-yes');
      var noBtn   = el('btn-tk-no');
      var skipBtn = el('btn-tk-skip');
      if (yesBtn)  yesBtn.classList.remove('hidden');
      if (noBtn)   noBtn.classList.remove('hidden');
      if (skipBtn) skipBtn.classList.add('hidden');

      function cleanup(answer) {
        if (yesBtn)  yesBtn.classList.add('hidden');
        if (noBtn)   noBtn.classList.add('hidden');
        if (skipBtn) skipBtn.classList.remove('hidden');
        yesBtn  && yesBtn.removeEventListener('click', onYes);
        noBtn   && noBtn.removeEventListener('click', onNo);
        document.removeEventListener('keydown', onKey);
        resolve(answer);
      }
      function onYes() { cleanup(true);  }
      function onNo()  { cleanup(false); }
      function onKey(e) { if (e.key === 'Enter') { e.preventDefault(); cleanup(true); } }

      yesBtn && yesBtn.addEventListener('click', onYes);
      noBtn  && noBtn.addEventListener('click',  onNo);
      document.addEventListener('keydown', onKey);
    });
  }

  // Send TAKEOFF_LISTEN_ENTER to ST tab AND inject into the currently active tab
  // so Enter works regardless of which tab the user is looking at
  async function broadcastListenEnter() {
    if (wf.stTabId) {
      chrome.tabs.sendMessage(wf.stTabId, { action: 'TAKEOFF_LISTEN_ENTER' }).catch(function(){});
    }
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      var activeId = tabs && tabs[0] && tabs[0].id;
      if (activeId && activeId !== wf.stTabId) {
        chrome.scripting.executeScript({
          target: { tabId: activeId },
          world: 'MAIN',
          func: function() {
            if (window.__dukeEnterInjected) return;
            window.__dukeEnterInjected = true;
            document.addEventListener('keydown', function _dukeEnter(e) {
              if (e.key === 'Enter') {
                window.__dukeEnterInjected = false;
                document.removeEventListener('keydown', _dukeEnter);
                var action = e.ctrlKey ? 'TAKEOFF_CTRL_ENTER_PRESSED' : 'TAKEOFF_ENTER_PRESSED';
                chrome.runtime.sendMessage({ action: action });
              }
            });
          }
        }).catch(function(){});
      }
    } catch(e) {}
  }

  // ── Sheet Classification ──────────────────────────────────────────────────────
  // NOTE: classifySheets is kept for future named-sheet support but not used in
  // the visual labelling loop below.
  function classifySheets(names) {
    // Matches numbered floors — also handles architectural sheet codes like "A1.0", "A-101"
    var FLOOR_DEFS = [
      {
        patterns: [/1st|first|floor[\s\-_]*1|level[\s\-_]*1|main[\s\-_]*(floor|level)|a[\-\.]?1[\-\.]?0|a[\-\.]?101/i],
        rename: '1st Floor Plan', order: 0
      },
      {
        patterns: [/2nd|second|floor[\s\-_]*2|level[\s\-_]*2|upper[\s\-_]*(floor|level)|a[\-\.]?1[\-\.]?1|a[\-\.]?102/i],
        rename: '2nd Floor Plan', order: 1
      },
      {
        patterns: [/3rd|third|floor[\s\-_]*3|level[\s\-_]*3|a[\-\.]?1[\-\.]?2|a[\-\.]?103/i],
        rename: '3rd Floor Plan', order: 2
      },
    ];
    var DELETE_PAT = /elevation|roof[\s\-_]*plan|foundation|title[\s\-_]*(page|sheet)|cover[\s\-_]*(sheet|page)|section|electrical|plumbing|mechanical|framing|site[\s\-_]*plan|landscape|civil|grading|survey|legend|exterior|detail|schedule|door[\s\-_]*schedule|window[\s\-_]*schedule/i;

    var floorPlans = [];
    var toDelete   = [];
    var unknown    = [];
    var seenRename = {};

    names.forEach(function (name) {
      if (DELETE_PAT.test(name)) { toDelete.push(name); return; }

      var matched = false;
      for (var i = 0; i < FLOOR_DEFS.length; i++) {
        var def = FLOOR_DEFS[i];
        if (def.patterns.some(function (p) { return p.test(name); })) {
          if (!seenRename[def.rename]) {
            seenRename[def.rename] = true;
            floorPlans.push({ name: name, rename: def.rename, order: def.order });
          } else {
            toDelete.push(name);
          }
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Generic floor/plan word → 1st floor if not taken
        if (/floor|plan/i.test(name)) {
          if (!seenRename['1st Floor Plan']) {
            seenRename['1st Floor Plan'] = true;
            floorPlans.push({ name: name, rename: '1st Floor Plan', order: 0 });
          } else if (!seenRename['2nd Floor Plan']) {
            seenRename['2nd Floor Plan'] = true;
            floorPlans.push({ name: name, rename: '2nd Floor Plan', order: 1 });
          } else {
            toDelete.push(name);
          }
        } else {
          unknown.push(name); // leave untouched
        }
      }
    });

    floorPlans.sort(function (a, b) { return a.order - b.order; });
    return { floorPlans: floorPlans, toDelete: toDelete, unknown: unknown };
  }

  // ── Main Workflow ─────────────────────────────────────────────────────────────

  async function runWorkflow() {
    wf.active = true;
    document.getElementById('tk-idle').classList.add('hidden');
    document.getElementById('tk-active').classList.remove('hidden');
    document.getElementById('tk-complete').classList.add('hidden');
    
    // Ensure the post-sheet estimate step is cleanly removed on a fresh start
    var tkEstimateContainer = document.getElementById('tk-estimate-step-container');
    if (tkEstimateContainer) tkEstimateContainer.innerHTML = '';
    wf.allowEnterForEstimate = false;
    wf.seqStep = 0; wf.seqMaxStep = -1; updateSeqNav();

    // Restore the write-to-sheet button in case it was hidden from a previous run
    var writeBtn = document.getElementById('btn-tk-write');
    if (writeBtn) { writeBtn.style.display = ''; writeBtn.disabled = false; }

    document.getElementById('tk-log').textContent = '';

    try {
      // ── Step 1: Find BuilderTrend takeoff tab ──────────────────────────────
      tkProgress(1, 9);
      tkSet('🔍', 'Finding takeoff tab…', 'Looking for open BuilderTrend tab');
      var tabs = await chrome.tabs.query({});
      // Prefer the squaretakeoff /takeoff tab specifically (the URL the user is actually on)
      var stTab = tabs.find(function (t) { return t.url && t.url.includes('squaretakeoff.com') && t.url.includes('/takeoff'); })
               || tabs.find(function (t) { return t.url && t.url.includes('squaretakeoff.com') && t.active; })
               || tabs.find(function (t) { return t.url && t.url.includes('squaretakeoff.com'); })
               || tabs.find(function (t) { return t.url && t.url.includes('buildertrend.net') && t.url.toLowerCase().includes('takeoff'); });
      if (!stTab) throw new Error('No takeoff tab found. Open app.squaretakeoff.com/takeoff first, then try again.');
      wf.stTabId = stTab.id;
      await chrome.tabs.update(stTab.id, { active: true });
      await delay(600);
      tkLog('✓ Tab: ' + stTab.url);

      // Ensure content script is active — probe first to avoid double-injection (which creates
      // duplicate message listeners). Only inject if the script isn't already loaded.
      var scriptReady = false;
      try {
        await stMsg('TAKEOFF_GET_SHEETS');
        scriptReady = true;
      } catch (connErr) {
        tkLog('Content script not ready — checking before injecting…');
        try {
          var probeRes = await chrome.scripting.executeScript({
            target: { tabId: stTab.id },
            func: function () { return !!window.__dukeListenerRegistered; }
          });
          var alreadyLoaded = probeRes && probeRes[0] && probeRes[0].result;
          if (!alreadyLoaded) {
            await chrome.scripting.executeScript({ target: { tabId: stTab.id }, files: ['content.js'] });
            tkLog('✓ Content script injected');
          } else {
            tkLog('Content script already loaded (listener present)');
          }
        } catch (injErr) {
          throw new Error('Cannot inject content script: ' + injErr.message + '. Try refreshing the SquareTakeoff tab.');
        }
      }

      // Wait for the content script to fully initialize (ST_AUTO ready) before proceeding
      if (!scriptReady) {
        for (var ping = 0; ping < 10; ping++) {
          await delay(600);
          try {
            await stMsg('TAKEOFF_GET_SHEETS');
            scriptReady = true;
            break;
          } catch (_) {}
        }
        if (!scriptReady) throw new Error('Content script did not respond after injection.');
      }

      // ── Step 2: Wait for SquareTakeoff's Kendo grid to render the page list ──
      // SquareTakeoff has an initialization race where mainGridChange fires before the
      // SVG editor iframe is ready, temporarily leaving the grid empty. We retry for up
      // to 40 seconds (50 × 800 ms) so a slow page load or slow server doesn't fail us.
      tkProgress(2, 9);
      tkSet('📋', 'Scanning sheets…', 'Waiting for SquareTakeoff to load…');
      var sheetCount = 0;
      var sheetNames = [];
      var diagDone = false;
      for (var sheetTry = 0; sheetTry < 50; sheetTry++) {
        // Update status every 5 retries so the user sees progress
        if (sheetTry > 0 && sheetTry % 5 === 0) {
          tkSet('📋', 'Scanning sheets…', 'Waiting for SquareTakeoff to load… (' + Math.round(sheetTry * 0.8) + 's)');
        }
        try {
          var execRes = await chrome.scripting.executeScript({
            target: { tabId: stTab.id, allFrames: false },
            func: function () {
              var cells = Array.from(document.querySelectorAll('td.tooltipPageName, [class*="tooltipPageName"]'));
              var kendoTd = document.querySelectorAll('.k-table-td, .k-grid-content td').length;
              return {
                count: cells.length,
                kendoTd: kendoTd,
                names: cells.map(function (el) {
                  return (el.getAttribute('title') || el.textContent || '').trim().split('\n')[0].trim();
                }),
                url: location.href,
                readyState: document.readyState,
              };
            }
          });

          var best = execRes && execRes[0] && execRes[0].result;
          if (!diagDone && best) {
            diagDone = true;
            tkLog('Page state: readyState=' + best.readyState + ' cells=' + best.count + ' kendoTd=' + best.kendoTd + ' url=' + (best.url||'').slice(0,60));
          }
          if (best && best.count > 0) {
            sheetCount = best.count;
            sheetNames = best.names || [];
            tkLog('✓ Found ' + sheetCount + ' sheet(s)');
            break;
          }
        } catch (execErr) {
          tkLog('executeScript error (try ' + sheetTry + '): ' + execErr.message);
        }
        await delay(800);
      }
      if (!sheetCount) throw new Error('SquareTakeoff page list did not load after 40 seconds. Please wait for the plan to fully open in SquareTakeoff (you should see all pages listed on the left), then try again.');

      // ── Step 2b: RESET + Auto-fit to comfortable view ────────────────────────
      tkSet('🔍', 'Auto-fitting view…', 'Clicking RESET then fitting plan to screen');
      try {
        await chrome.scripting.executeScript({
          target: { tabId: wf.stTabId },
          world: 'MAIN',
          files: ['auto-fit.js']
        });
        await delay(800);
      } catch (e) { tkLog('⚠ Auto-fit: ' + e.message); }

      // ── Step 3: Use Page Management "Use AI Name" to label all sheets ────────
      tkProgress(3, 7);

      // Check if sheets are already named as floor plans — if so, skip AI naming
      var pagesAlreadyNamed = sheetNames.some(function (n) {
        return /1st|2nd|3rd|4th|first|second|third|fourth/i.test(n) && /floor/i.test(n);
      });

      var aiSkipped = false;
      if (pagesAlreadyNamed) {
        tkLog('✓ Pages already named — skipping AI page naming');
        aiSkipped = true;
      } else {
        tkLog('Sheet count: ' + sheetCount + ' — using Page Management AI naming to identify floor plans');
        tkSet('🤖', 'Identifying floor plans', 'Opening Page Management → enabling AI page names…');
      }

      if (!aiSkipped) try {
        var aiResult = await Promise.race([stMsg('TAKEOFF_USE_AI_PAGE_NAMES'), waitForSkip()]);
        if (aiResult === 'skip') {
          aiSkipped = true;
          tkLog('⏭ AI page naming skipped — closing Page Management…');
          // Close the Page Management modal if it is still open
          try {
            await chrome.scripting.executeScript({
              target: { tabId: stTab.id },
              func: function () {
                var closeBtn = document.getElementById('ReorderPageMgmtTakeoffmodalButtonX');
                if (closeBtn && closeBtn.offsetParent !== null) { closeBtn.click(); return; }
                var anyClose = document.querySelector('[class*="modal"] [class*="close"], [data-dismiss="modal"]');
                if (anyClose) anyClose.click();
              }
            });
          } catch (_) {}
        } else if (!aiResult || !aiResult.ok) throw new Error((aiResult && aiResult.error) || 'Unknown error');
        else tkLog('✓ AI page naming complete — reading updated sheet names…');
      } catch (e) {
        tkLog('⚠ AI page naming failed: ' + e.message + ' — continuing with original sheet names');
        aiSkipped = true;
        // Close Page Management modal if still open (same as skip path)
        try {
          await chrome.scripting.executeScript({
            target: { tabId: stTab.id },
            func: function () {
              var closeBtn = document.getElementById('ReorderPageMgmtTakeoffmodalButtonX');
              if (closeBtn && closeBtn.offsetParent !== null) { closeBtn.click(); return; }
              var anyClose = document.querySelector('[class*="modal"] [class*="close"], [data-dismiss="modal"]');
              if (anyClose) anyClose.click();
            }
          });
        } catch (_) {}
        await delay(800);
      } finally { clearSkip(); }

      // If AI naming was skipped or failed nothing was actually renamed —
      // use the original sheet names to avoid reading stale/modal DOM content.
      var namedSheets = [];
      if (aiSkipped) {
        namedSheets = sheetNames;
        tkLog('Using original sheet names (AI naming skipped/failed)');
      } else {
        await delay(1000);
        try {
          var namedExec = await chrome.scripting.executeScript({
            target: { tabId: stTab.id, allFrames: true },
            func: function () {
              var cells = Array.from(document.querySelectorAll('td.tooltipPageName, [class*="tooltipPageName"]'));
              return { count: cells.length, names: cells.map(function (el) {
                return (el.getAttribute('title') || el.textContent || '').trim().split('\n')[0].trim();
              }) };
            }
          });
          var bestNamed = (namedExec || []).reduce(function (prev, r) {
            var v = r && r.result;
            return (v && v.count > (prev ? prev.count : 0)) ? v : prev;
          }, null);
          namedSheets = (bestNamed && bestNamed.names) || [];
        } catch (_) { namedSheets = sheetNames; }
      }
      tkLog('Sheet names after AI: ' + namedSheets.join(', '));

      function normalizeSheetLabel(name) {
        if (!name) return null;
        var t = name.toLowerCase();
        if (/4th|fourth/i.test(t))  return '4th Floor Plan';
        if (/3rd|third/i.test(t))   return '3rd Floor Plan';
        if (/2nd|second/i.test(t))  return '2nd Floor Plan';
        if (/1st|first/i.test(t))   return '1st Floor Plan';
        // Plain "Floor Plan" with no floor number → assume 1st
        if (/floor\s*plan/i.test(t) && !/elevation|site|found|roof|section|schedule/i.test(t)) return '1st Floor Plan';
        return null;
      }

      var VALID_FLOOR = ['1st Floor Plan', '2nd Floor Plan', '3rd Floor Plan', '4th Floor Plan'];
      var classified = [];
      var seenFloorLabels = new Set();
      for (var si = 0; si < namedSheets.length; si++) {
        var lbl = normalizeSheetLabel(namedSheets[si]);
        // Deduplicate by label — only keep the first sheet that maps to each floor label
        if (lbl && !seenFloorLabels.has(lbl)) {
          seenFloorLabels.add(lbl);
          classified.push({ index: si, label: lbl, pageName: namedSheets[si].trim().toUpperCase() });
        }
      }
      classified.sort(function (a, b) { return VALID_FLOOR.indexOf(a.label) - VALID_FLOOR.indexOf(b.label); });
      wf.floors = classified;
      tkLog('Floor plans: ' + (classified.length ? classified.map(function (c) { return 'Sheet '+(c.index+1)+' = '+c.label; }).join(', ') : 'none detected'));
      if (!wf.floors.length) throw new Error('No floor plans found after AI page naming. Check sheet names in Page Management.');

      await delay(2000);

      // ── Step 4: Auto-set scale per floor ─────────────────────────────────────
      tkProgress(4, 7);

      // Check DOM — if scale is already set on the first floor, skip the whole step
      var existingScaleRes = await new Promise(function (res) {
        chrome.tabs.sendMessage(wf.stTabId, { action: 'TAKEOFF_GET_PAGE_SCALE' }, res);
      });
      var existingScale = existingScaleRes && existingScaleRes.ok ? (existingScaleRes.scale || '') : '';
      if (existingScale && /\d+\/\d+/.test(existingScale)) {
        tkLog('✓ Scale already set (' + existingScale + ') — skipping scale step');
      } else {

      // Focus panel so the user sees the question
      chrome.runtime.sendMessage({ action: 'FOCUS_PANEL' });
      await delay(300);

      var normalScale = await tkAskYesNo(
        '📏',
        'Scale check',
        'Is this plan using normal 1/4" = 1\'0" scaling?'
      );

      if (normalScale) {
        // Open scale once on first floor — "apply to all pages" handles remaining floors
        tkSet('📏', 'Setting scale…', 'Applying 1/4" = 1\'0" to all floor plans');
        try {
          await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: wf.floors[0].pageName });
          await delay(600);
          await stMsg('TAKEOFF_SET_SCALE', { scale: '1/4" = 1\'0"', applyAll: true });
          tkLog('✓ Scale set: 1/4" = 1\'0" (applied to all pages)');
        } catch (e) { tkLog('⚠ Scale error: ' + e.message); }
      } else {
        // User said No — open scale dialog per floor with Imperial + Set Via Page Scale pre-selected
        for (var msi = 0; msi < wf.floors.length; msi++) {
          try {
            await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: wf.floors[msi].pageName });
            await delay(600);
            try { await stMsg('TAKEOFF_OPEN_SCALE_MANUAL', {}); } catch (_) {}
            tkSet('📏', 'Set scale: ' + wf.floors[msi].label,
              'Imperial selected. Choose your scale and click Start — this step will advance automatically.',
              false, true);
            var manualResult = await Promise.race([
              stMsg('TAKEOFF_WAIT_FOR_SCALE_START', {}).then(function () { return 'done'; }),
              waitForUser()
            ]);
            if (manualResult === 'cancel') throw new Error('Cancelled by user');
            tkLog(manualResult === 'skip' ? '○ Scale skipped for ' + wf.floors[msi].label : '✓ Scale set for ' + wf.floors[msi].label);
            await delay(500);
          } catch (e) {
            if (e.message === 'Cancelled by user') throw e;
            tkLog('⚠ Scale for ' + wf.floors[msi].label + ': ' + e.message);
          } finally { clearSkip(); }
        }
      }
      } // end else (scale not already set)

      // ── Count Takeoff (per floor) ─────────────────────────────────────────────
      tkProgress(5, 7);
      wf.skipAllCounts = false;

      // Auto-detect: check if all required counts already exist on each floor
      tkSet('🔍', 'Checking existing counts…', 'Verifying count rows for all floors');
      var countsComplete = true;
      for (var cfi = 0; cfi < wf.floors.length && countsComplete; cfi++) {
        await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: wf.floors[cfi].pageName });
        await delay(1200); // wait for sidebar to reflect new floor
        var cfiLabel = wf.floors[cfi].label;
        var cfiIsFirst = wf.floors.length === 1 || (cfi === 0 && !/2nd|3rd|4th|second|third|fourth/i.test(cfiLabel));
        var floorCountCheck = cfiIsFirst ? COUNT_ITEMS : COUNT_ITEMS.filter(function (c) {
          return !/^(Porch Columns|Garage Doors)$/i.test(c.label);
        });
        for (var cci = 0; cci < floorCountCheck.length && countsComplete; cci++) {
          var checkRes = await stMsg('TAKEOFF_CHECK_ROW_EXISTS', {
            name: floorCountCheck[cci].label, floorLabel: cfiLabel, pageName: wf.floors[cfi].pageName
          });
          if (!checkRes || !checkRes.exists) countsComplete = false;
        }
      }

      if (countsComplete) {
        tkLog('✓ All counts already present — skipping count takeoff');
        wf.skipAllCounts = true;
      }

      // Show the "Skip All Counts" button for the duration of the count phase
      var skipAllBtn = document.getElementById('btn-tk-skip-all-counts');
      if (skipAllBtn && !wf.skipAllCounts) skipAllBtn.classList.remove('hidden');

      for (var fi = 0; fi < wf.floors.length && !wf.skipAllCounts; fi++) {
        var floorObj  = wf.floors[fi];
        var floorName = floorObj.label;
        tkSet('🗂️', 'Navigating to ' + floorName + '…', 'Setting up count takeoff');
        await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: floorObj.pageName });
        await delay(1000);

        // Porch Columns and Garage Doors are 1st-floor-only counts.
        // Single-page projects always get all 7 counts regardless of label.
        var isFirstFloorPage = wf.floors.length === 1 || (fi === 0 && !/2nd|3rd|4th|second|third|fourth/i.test(floorName));
        var floorCountItems = isFirstFloorPage
          ? COUNT_ITEMS
          : COUNT_ITEMS.filter(function (c) {
              return !/^(Porch Columns|Garage Doors)$/i.test(c.label);
            });

        for (var ci = 0; ci < floorCountItems.length && !wf.skipAllCounts; ci++) {
          var cItem = floorCountItems[ci];

          // Skip this count if it already exists on this floor
          var alreadyExists = await stMsg('TAKEOFF_CHECK_ROW_EXISTS', { name: cItem.label, floorLabel: floorName, pageName: floorObj.pageName });
          if (alreadyExists && alreadyExists.exists) {
            tkLog('⏭ ' + cItem.label + ' already exists on ' + floorName + ' — skipping');
            continue;
          }

          tkSet('🔢', 'Creating count: ' + cItem.label, 'Setting up on ' + floorName + '…');
          try {
            await stMsg('TAKEOFF_OPEN_COUNT', {
              name: cItem.label,
              floorLabel: floorName,
              pageName: floorObj.pageName,
              totalFloors: wf.floors.length,
              floorIndex: fi
            });
          } catch (e) { tkLog('⚠ Count setup "' + cItem.label + '": ' + e.message); }

          tkSet('👆', cItem.label + ' — ' + floorName, cItem.msg, true, true);
          await broadcastListenEnter();
          var cAction = await waitForUser();
          if (cAction === 'cancel') throw new Error('Cancelled by user');
          tkLog((cAction === 'skip' ? '○ Skipped' : '✓ Done') + ': ' + cItem.label + ' on ' + floorName);
        }
      }

      if (skipAllBtn) skipAllBtn.classList.add('hidden');
      if (wf.skipAllCounts) tkLog('⏭ All counts skipped — jumping to area takeoff');

      // ── Verify counts — auto-create any missing, remove 1st-floor-only from upper floors ──
      var FIRST_FLOOR_ONLY_COUNTS = ['Porch Columns', 'Garage Doors'];
      tkSet('✅', 'Verifying counts…', 'Checking all count items exist for each floor');
      for (var vfi = 0; vfi < wf.floors.length; vfi++) {
        var vFloor = wf.floors[vfi];
        await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: vFloor.pageName });
        await delay(800);

        var vFloorIsFirst = wf.floors.length === 1 || (vfi === 0 && !/2nd|3rd|4th|second|third|fourth/i.test(vFloor.label));

        var verifyItems = vFloorIsFirst
          ? COUNT_ITEMS
          : COUNT_ITEMS.filter(function (c) {
              return FIRST_FLOOR_ONLY_COUNTS.indexOf(c.label) === -1;
            });
        for (var vci = 0; vci < verifyItems.length; vci++) {
          var vItem = verifyItems[vci];
          var vExists = await stMsg('TAKEOFF_CHECK_ROW_EXISTS', { name: vItem.label, floorLabel: vFloor.label, pageName: vFloor.pageName });
          if (vExists && vExists.exists) {
            tkLog('⏭ ' + vItem.label + ' already exists on ' + vFloor.label + ' — skipping');
            continue;
          }
          // Missing — create the row and prompt user to do the takeoff
          tkSet('🔢', 'Creating count: ' + vItem.label, 'Setting up on ' + vFloor.label + '…');
          try {
            await stMsg('TAKEOFF_OPEN_COUNT', { name: vItem.label, floorLabel: vFloor.label, pageName: vFloor.pageName, totalFloors: wf.floors.length, floorIndex: vfi });
          } catch (e) { tkLog('⚠ Count setup "' + vItem.label + '": ' + e.message); }
          tkSet('👆', vItem.label + ' — ' + vFloor.label, vItem.msg, true, true);
          await broadcastListenEnter();
          var vAction = await waitForUser();
          if (vAction === 'cancel') throw new Error('Cancelled by user');
          tkLog((vAction === 'skip' ? '○ Skipped' : '✓ Done') + ': ' + vItem.label + ' on ' + vFloor.label);
        }
        tkLog('✓ Counts verified for ' + vFloor.label);
      }

      // ── Area Takeoff (per floor) ──────────────────────────────────────────────
      tkProgress(6, 7);

      // Check Garage Doors count on 1st floor BEFORE showing config popup
      tkSet('🔍', 'Checking garage…', 'Reading garage door count');
      await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: wf.floors[0].pageName });
      await delay(600);
      var garageDoorCheck = await stMsg('TAKEOFF_CHECK_ROW_EXISTS', { name: 'Garage Doors', floorLabel: wf.floors[0].label, pageName: wf.floors[0].pageName });
      var hasGarageDoors = garageDoorCheck && garageDoorCheck.count > 0;
      tkLog('Garage Doors count = ' + (garageDoorCheck ? garageDoorCheck.count : 0) + ' → garage area ' + (hasGarageDoors ? 'included' : 'skipped'));

      // ── Check if all flooring areas already exist — if so, skip specs entirely ─
      var flooringAlreadyDone = false;
      if (wf.floors.length > 0) {
        var FL_TYPES = ['Hardwood', 'Carpet', 'Tile'];
        flooringAlreadyDone = true;
        floorCheck: for (var fci = 0; fci < wf.floors.length; fci++) {
          for (var fti = 0; fti < FL_TYPES.length; fti++) {
            var ftRes = await stMsg('TAKEOFF_CHECK_ROW_EXISTS', {
              name: FL_TYPES[fti], floorLabel: wf.floors[fci].label, pageName: wf.floors[fci].pageName
            });
            if (!ftRes || !ftRes.exists) { flooringAlreadyDone = false; break floorCheck; }
          }
        }
        if (flooringAlreadyDone) tkLog('✓ All flooring areas already exist — skipping specs step');
      }

      // ── Ask user which pages are Specs, then extract flooring notes ──────────
      // Re-read sheet names now — namedSheets was captured before scale/count navigation,
      // which can cause SquareTakeoff to show a mix of old and new names in the DOM.
      try {
        var freshExec = await chrome.scripting.executeScript({
          target: { tabId: stTab.id, frameId: 0 },
          func: function () {
            var cells = Array.from(document.querySelectorAll('td.tooltipPageName'));
            return { count: cells.length, names: cells.map(function (el) {
              return (el.textContent || el.getAttribute('title') || '').trim().split('\n')[0].trim();
            }) };
          }
        });
        var freshResult = freshExec && freshExec[0] && freshExec[0].result;
        if (freshResult && freshResult.names && freshResult.names.length) {
          namedSheets = freshResult.names;
          tkLog('Sheet names (refreshed): ' + namedSheets.join(', '));
        }
      } catch (_) {}

      var flooringNotes = null;
      if (!flooringAlreadyDone) try {
        // Build a filtered list for the specs picker — exclude floor plan pages and
        // clearly non-spec architectural pages (elevations, foundation, roof, etc.)
        var floorPageNamesUpper = wf.floors.map(function(f) { return f.pageName; });
        var NON_SPEC_PATTERN = /\b(elevation|foundation|roof plan|cover sheet|bracing|framing|permit)\b/i;
        var PDF_PAGE_PATTERN = /\.pdf\s*-\s*page\s*\d+$/i;
        var specsPageNames = namedSheets.filter(function(name) {
          if (PDF_PAGE_PATTERN.test(name)) return false;
          if (floorPageNamesUpper.indexOf(name.trim().toUpperCase()) !== -1) return false;
          if (NON_SPEC_PATTERN.test(name)) return false;
          return true;
        });

        tkSet('📋', 'Specs check', 'Select any specs pages to scan for flooring');
        var specIdxs = await selectSpecsPages(specsPageNames);
        tkLog('Specs pages selected: ' + (specIdxs.length ? specIdxs.map(function(i){ return specsPageNames[i]; }).join(', ') : 'none'));
        if (specIdxs.length) {
          tkSet('📋', 'Reading flooring specs…', 'Scanning Included Features / Specs pages');
          for (var spi = 0; spi < specIdxs.length; spi++) {
            var specPageIdx = specIdxs[spi];
            try {
              var _t0 = performance.now();
              console.log('[Duke Timing] [' + specsPageNames[specPageIdx] + '] START spec page processing @' + _t0.toFixed(0) + 'ms');

              // Capture current image URL so we can detect when the page actually changes
              var beforeImgRes = await new Promise(function (res) {
                chrome.tabs.sendMessage(wf.stTabId, { action: 'TAKEOFF_GET_PAGE_IMAGE_URL' }, { frameId: 0 }, res);
              });
              var beforeUrl = beforeImgRes && beforeImgRes.ok ? beforeImgRes.url : null;

              // Navigate to the specs page by name (same mechanism as floor navigation)
              var _tNavStart = performance.now();
              await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: specsPageNames[specPageIdx].trim().toUpperCase() });

              // Poll until the svgedit image URL changes (up to 10 seconds)
              var imageUrl = null;
              for (var wi = 0; wi < 100; wi++) {
                await delay(100);
                var imgRes = await new Promise(function (res) {
                  chrome.tabs.sendMessage(wf.stTabId, { action: 'TAKEOFF_GET_PAGE_IMAGE_URL' }, { frameId: 0 }, res);
                });
                var candidateUrl = imgRes && imgRes.ok ? imgRes.url : null;
                if (candidateUrl && candidateUrl !== beforeUrl) { imageUrl = candidateUrl; break; }
              }
              var _tNavEnd = performance.now();
              console.log('[Duke Timing] [' + namedSheets[specPageIdx] + '] NAV + page load: ' + (_tNavEnd - _tNavStart).toFixed(0) + 'ms (polls: ' + (wi + 1) + ')');

              if (!imageUrl) {
                // URL never changed — read whatever is current (page may render outside svgedit)
                var fallbackRes = await new Promise(function (res) {
                  chrome.tabs.sendMessage(wf.stTabId, { action: 'TAKEOFF_GET_PAGE_IMAGE_URL' }, { frameId: 0 }, res);
                });
                imageUrl = fallbackRes && fallbackRes.ok ? fallbackRes.url : null;
                if (!imageUrl) { tkLog('⚠ No image found for ' + specsPageNames[specPageIdx]); continue; }
                tkLog('⚠ URL unchanged after nav — using current image for ' + specsPageNames[specPageIdx]);
              }
              tkLog('Included Features image URL: ' + imageUrl.slice(0, 80) + '…');

              // Send to background for GPT-4o extraction
              var _tExtractStart = performance.now();
              var extractRes = await new Promise(function (res) {
                chrome.runtime.sendMessage({ action: 'EXTRACT_FLOORING_SPECS', imageUrl: imageUrl, stTabId: wf.stTabId }, res);
              });
              var _tExtractEnd = performance.now();
              console.log('[Duke Timing] [' + specsPageNames[specPageIdx] + '] EXTRACT_FLOORING_SPECS total: ' + (_tExtractEnd - _tExtractStart).toFixed(0) + 'ms');
              console.log('[Duke Timing] [' + specsPageNames[specPageIdx] + '] FULL page total: ' + (_tExtractEnd - _t0).toFixed(0) + 'ms');

              if (extractRes && extractRes.ok && extractRes.result) {
                var r = extractRes.result;
                if (!flooringNotes) {
                  flooringNotes = { flooring: [], hardwood: [], carpet: [], tile: [] };
                }
                // Merge, dedup by normalized text
                function mergeNotes(target, src) {
                  var seen = new Set(target.map(function (n) { return n.trim().toLowerCase(); }));
                  (src || []).forEach(function (n) {
                    if (!seen.has(n.trim().toLowerCase())) { target.push(n); seen.add(n.trim().toLowerCase()); }
                  });
                }
                mergeNotes(flooringNotes.flooring,  r.flooring);
                mergeNotes(flooringNotes.hardwood,  r.hardwood);
                mergeNotes(flooringNotes.carpet,    r.carpet);
                mergeNotes(flooringNotes.tile,      r.tile);
                tkLog('✓ Flooring notes extracted from ' + specsPageNames[specPageIdx]);
              } else {
                tkLog('⚠ Flooring extraction failed for ' + specsPageNames[specPageIdx] + ': ' + (extractRes && extractRes.error));
              }
            } catch (specE) { tkLog('⚠ Specs page error: ' + specE.message); }
          }
          // Render notes above the questionnaire
          if (flooringNotes) renderFlooringNotes(flooringNotes);
          // Navigate back to first floor before showing questionnaire
          if (wf.floors.length) {
            await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: wf.floors[0].pageName });
            await delay(600);
          }
        }
      } catch (specErr) { tkLog('⚠ Flooring spec scan: ' + specErr.message); }

      chrome.runtime.sendMessage({ action: 'FOCUS_PANEL' });
      await delay(200);
      tkSet('⚙️', 'Area Setup', 'Choose your floor count and optional areas below');
      var areaCfg = await collectAreaConfig(flooringNotes);
      areaCfg.hasGarage = hasGarageDoors;
      tkLog('Area config: ' + areaCfg.floors + ' floor(s)' +
        (areaCfg.rearPorch ? ', Rear Porch' : '') +
        (areaCfg.rearDeck ? ', Rear Deck' : '') +
        (areaCfg.basement ? ', Basement' : '') +
        (areaCfg.atticStorage ? ', Attic w/ Storage' : '') +
        (areaCfg.habitableAttic ? ', Habitable Attic' : ''));

      var areaFloorCount = (wf.floors.length === 1) ? areaCfg.floors : wf.floors.length;
      for (var fi2 = 0; fi2 < areaFloorCount; fi2++) {
        var floorObj2  = wf.floors[fi2] || wf.floors[0];
        var floorName2 = (wf.floors.length === 1 && fi2 > 0)
          ? (fi2 === 1 ? '2nd Floor' : fi2 === 2 ? '3rd Floor' : (fi2 + 1) + 'th Floor')
          : floorObj2.label;
        await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: floorObj2.pageName });
        await delay(1000);

        var floorAreaItems = areaItemsForFloorPage(fi2, areaCfg, areaFloorCount);

        for (var ai = 0; ai < floorAreaItems.length; ai++) {
          var aName = floorAreaItems[ai];

          // Auto-skip if this area already exists on this floor page
          var aExists = await stMsg('TAKEOFF_CHECK_ROW_EXISTS', { name: aName, floorLabel: floorName2, pageName: floorObj2.pageName });
          if (aExists && aExists.exists) {
            tkLog('⏭ ' + aName + ' already exists on ' + floorName2 + ' — skipping');
            continue;
          }

          tkSet('📐', 'Creating area: ' + aName, 'Setting up on ' + floorName2 + '…');
          try {
            await stMsg('TAKEOFF_OPEN_AREA', { name: aName, floorLabel: floorName2, totalFloors: areaFloorCount, floorIndex: fi2 });
          } catch (e) { tkLog('⚠ Area setup "' + aName + '": ' + e.message); }

          tkSet('📐', aName + ' — ' + floorName2,
            'Draw the ' + aName + ' area on the plan, then press Enter or Done.\nPress Skip → to skip this area (enters 0).',
            true, true);
          await broadcastListenEnter();
          var aAction = await waitForUser();
          if (aAction === 'cancel') throw new Error('Cancelled by user');
          await stMsg('TAKEOFF_STOP_AREA_SESSION');
          tkLog((aAction === 'skip' ? '○ Skipped' : '✓ Done') + ': ' + aName + ' on ' + floorName2);
        }
      }

      // ── Flooring Area Takeoffs (per floor, based on user selections) ─────────────
      for (var ffi = 0; ffi < areaFloorCount; ffi++) {
        var ffFloor = wf.floors[ffi] || wf.floors[0];
        var ffLabel = (wf.floors.length === 1 && ffi > 0)
          ? (ffi === 1 ? '2nd Floor' : ffi === 2 ? '3rd Floor' : (ffi + 1) + 'th Floor')
          : ffFloor.label;
        var flooringItems = (areaCfg.flooringPerFloor && areaCfg.flooringPerFloor[ffi]) ? areaCfg.flooringPerFloor[ffi] : [];
        if (flooringItems.length === 0) continue;

        await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: ffFloor.pageName });
        await delay(1000);

        var flForceReopen = false;
        for (var fli = 0; fli < flooringItems.length; fli++) {
          var flName = flooringItems[fli];

          var flIsReopen = flForceReopen;
          if (!flIsReopen) {
            var flExists = await stMsg('TAKEOFF_CHECK_ROW_EXISTS', { name: flName, floorLabel: ffLabel, pageName: ffFloor.pageName });
            if (flExists && flExists.exists) {
              tkLog('⏭ ' + flName + ' already exists on ' + ffLabel + ' — skipping');
              continue;
            }
          }
          flForceReopen = false;

          tkSet('📐', 'Creating flooring area: ' + flName, 'Setting up on ' + ffLabel + '…');
          try {
            await stMsg('TAKEOFF_OPEN_AREA', { name: flName, floorLabel: ffLabel, totalFloors: areaFloorCount, floorIndex: ffi });
          } catch (e) { tkLog('⚠ Flooring area setup "' + flName + '": ' + e.message); }

          tkSet('📐', flName + ' — ' + ffLabel,
            'Draw the ' + flName + ' area on the plan, then press Enter or Done.\nPress Skip → to skip this area.\nCtrl+Enter → add another measurement.',
            true, true);
          await broadcastListenEnter();
          var flAction = await waitForUser();
          if (flAction === 'cancel') throw new Error('Cancelled by user');
          await stMsg('TAKEOFF_STOP_AREA_SESSION');
          if (flAction === 'restart') { tkLog('↺ Restarting: ' + flName + ' on ' + ffLabel); flForceReopen = true; fli--; continue; }
          tkLog((flAction === 'skip' ? '○ Skipped' : '✓ Done') + ': ' + flName + ' on ' + ffLabel);
        }
      }

      // Hide flooring notes now that all area takeoffs are complete
      var notesBoxDone = document.getElementById('tk-flooring-notes');
      if (notesBoxDone) notesBoxDone.classList.add('hidden');

      // ── Linear Takeoff (per floor) ────────────────────────────────────────────
      tkProgress(7, 7);
      for (var lfi = 0; lfi < wf.floors.length; lfi++) {
        var lFloor = wf.floors[lfi];
        tkSet('🗂️', 'Linear takeoff: ' + lFloor.label, 'Navigating to floor…');
        await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: lFloor.pageName });
        await delay(800);

        var lForceReopen = false;
        for (var li = 0; li < LINEAR_ITEMS.length; li++) {
          var lName = LINEAR_ITEMS[li];

          var lIsReopen = lForceReopen;
          if (!lIsReopen) {
            var lExists = await stMsg('TAKEOFF_CHECK_ROW_EXISTS', { name: lName, floorLabel: lFloor.label, pageName: lFloor.pageName });
            if (lExists && lExists.exists) {
              tkLog('⏭ ' + lName + ' already exists on ' + lFloor.label + ' — skipping');
              continue;
            }
          }
          lForceReopen = false;

          tkSet('📏', (lIsReopen ? 'Reopening' : 'Creating') + ' linear: ' + lName, 'Setting up on ' + lFloor.label + '…');
          try {
            if (lIsReopen) {
              await stMsg('TAKEOFF_REOPEN_LINEAR', { name: lName, floorLabel: lFloor.label });
            } else {
              await stMsg('TAKEOFF_OPEN_LINEAR', { name: lName });
            }
          } catch (e) { tkLog('⚠ Linear setup "' + lName + '": ' + e.message); }

          tkSet('📏', lName + ' — ' + lFloor.label,
            'Draw the ' + lName + ' measurement on the plan, then press Enter or Done.\nCtrl+Enter → add another measurement.',
            true, true);
          await broadcastListenEnter();
          var lAction = await waitForUser();
          if (lAction === 'cancel') throw new Error('Cancelled by user');
          await stMsg('TAKEOFF_STOP_AREA_SESSION');
          if (lAction === 'restart') { tkLog('↺ Restarting: ' + lName + ' on ' + lFloor.label); lForceReopen = true; li--; continue; }
          tkLog((lAction === 'skip' ? '○ Skipped' : '✓ Done') + ': ' + lName + ' on ' + lFloor.label);
        }
      }

      // ── Complete ──────────────────────────────────────────────────────────────
      tkProgress(7, 7);
      document.getElementById('tk-active').classList.add('hidden');
      document.getElementById('tk-complete').classList.remove('hidden');
      if (typeof showStatus === 'function')
        showStatus('✓ Takeoff complete! Press "Write to Sheet" to save all values.', 'success', 0);

    } catch (e) {
      tkSet('❌', 'Error', e.message);
      tkLog('ERROR: ' + e.message);
      if (typeof showStatus === 'function')
        showStatus('Takeoff error: ' + e.message, 'error', 10000);
    } finally {
      wf.active = false;
    }
  }

  // ── Write to Sheet from workflow ──────────────────────────────────────────────

  async function workflowWriteToSheet() {
    var btn = document.getElementById('btn-tk-write');
    if (btn) { btn.disabled = true; btn.textContent = 'Reading takeoff data…'; }
    if (typeof showStatus === 'function') showStatus('Reading takeoff data…', 'info', 0);

    try {
      if (typeof writeValues !== 'function') {
        if (typeof showStatus === 'function') showStatus('Extension not ready — reload the panel.', 'error', 4000);
        return;
      }
      if (!wf.stTabId) throw new Error('No SquareTakeoff tab — restart the workflow.');

      // Read each takeoff row directly via content script (avoids fragile DOM text scraping)
      async function getRowVal(name, floorLabel, pageName) {
        try {
          var res = await chrome.tabs.sendMessage(wf.stTabId,
            { action: 'TAKEOFF_GET_ROW_VALUE', name: name, floorLabel: floorLabel || '', pageName: pageName || '' },
            { frameId: 0 });
          return (res && res.ok) ? (res.value || 0) : 0;
        } catch (_) { return 0; }
      }

      var data = {};

      // Area items, flooring, and linear are page-specific (lazy-loaded per floor in ST).
      // Navigate to each floor before reading so ST renders that floor's rows in the DOM.
      // Count items are global in SquareTakeoff (same row appears on every floor page),
      // so they are read only once from floor 0 to prevent doubling on multi-floor plans.

      var AREA_KEY = {
        '1st Floor': '1st floor', '2nd Floor': '2nd floor', '3rd Floor': '3rd floor',
        'Attic with Storage': 'attic with storage', 'Habitable Attic': 'habitable attic',
        'Front Porch': 'front porch', 'Rear Porch': 'rear porch', 'Rear Deck': 'rear deck',
        'Garage': 'garage', 'Basement': 'basement',
      };
      var FL_KEY = { 'Hardwood': 'sf of hardwood', 'Carpet': 'sf of carpet', 'Tile': 'sf of tile' };

      for (var ai = 0; ai < wf.floors.length; ai++) {
        var aFloor = wf.floors[ai];
        // Navigate to this floor so ST renders its rows before we read
        try { await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: aFloor.pageName }); } catch (_) {}
        await delay(800);

        for (var aName in AREA_KEY) {
          var aVal = await getRowVal(aName, aFloor.label, aFloor.pageName);
          if (aVal > 0) { data[AREA_KEY[aName]] = aVal; tkLog('  ' + aName + ' (' + aFloor.label + '): ' + aVal); }
        }

        for (var flName2 in FL_KEY) {
          var flVal2 = await getRowVal(flName2, aFloor.label, aFloor.pageName);
          if (flVal2 > 0) { data[FL_KEY[flName2]] = (data[FL_KEY[flName2]] || 0) + flVal2; tkLog('  ' + flName2 + ' (' + aFloor.label + '): ' + flVal2); }
        }

        var cabVal = await getRowVal('Cabinets', aFloor.label, aFloor.pageName);
        var ctVal  = await getRowVal('Countertops', aFloor.label, aFloor.pageName);
        if (cabVal > 0) { data['cabinets lf'] = (data['cabinets lf'] || 0) + cabVal; tkLog('  Cabinets (' + aFloor.label + '): ' + cabVal); }
        if (ctVal  > 0) { data['countertops lf'] = (data['countertops lf'] || 0) + ctVal; tkLog('  Countertops (' + aFloor.label + '): ' + ctVal); }
      }

      // Count rows are per-floor — navigate to each floor and sum across all floors
      var COUNT_KEY = {
        'Exterior Doors': '# of exterior doors', 'Interior Doors': '# of interior doors',
        'Windows': '# of windows', 'Baths': '# of baths', 'Staircases': '# of staircases',
        'Porch Columns': '# of front porch columns', 'Garage Doors': '# of garage doors',
      };
      for (var ci = 0; ci < wf.floors.length; ci++) {
        var cFloor = wf.floors[ci];
        try { await stMsg('TAKEOFF_CLICK_SHEET_INDEX', { pageName: cFloor.pageName }); } catch (_) {}
        await delay(800);
        for (var cName in COUNT_KEY) {
          var cVal = await getRowVal(cName, cFloor.label, cFloor.pageName);
          if (cVal > 0) { data[COUNT_KEY[cName]] = (data[COUNT_KEY[cName]] || 0) + cVal; tkLog('  ' + cName + ' (' + cFloor.label + '): ' + cVal); }
        }
      }

      tkLog('Read ' + Object.keys(data).length + ' values from takeoff rows');

      if (btn) btn.textContent = 'Writing to Sheet…';
      if (Object.keys(data).length) {
        await writeValues(data);
        // Sheet write succeeded — hide the write button and show the estimate step in its place
        var tkComplete = document.getElementById('tk-complete');
        if (tkComplete) tkComplete.classList.add('hidden');
        // Hide the write-to-sheet button so it doesn't show alongside the estimate step
        if (btn) { btn.disabled = false; btn.style.display = 'none'; btn.textContent = 'Grab & Write to Sheet'; }
        var tkEstimateContainer = document.getElementById('tk-estimate-step-container');
        if (tkEstimateContainer) {
          tkEstimateContainer.innerHTML = buildEstimateStepHTML();
          wireDynamicEstimateButton();
        }
        wf.allowEnterForEstimate = true;
        wf.seqStep = 1; wf.seqMaxStep = Math.max(wf.seqMaxStep, 1); updateSeqNav();
        return; // skip the finally reset — btn is hidden intentionally
      } else {
        if (typeof showStatus === 'function') showStatus('No takeoff data found — try re-scanning.', 'error', 4000);
      }
    } catch (e) {
      if (typeof showStatus === 'function') showStatus('Write error: ' + e.message, 'error', 6000);
    } finally {
      // Only re-enable/show the button if we didn't succeed (success path returns early above)
      if (btn && btn.style.display !== 'none') { btn.disabled = false; btn.textContent = 'Grab & Write to Sheet'; }
    }
  }

  function showClientPreviewCard() {
    var tkEstimateContainer = document.getElementById('tk-estimate-step-container');
    if (!tkEstimateContainer) return;
    tkEstimateContainer.innerHTML = `
      <div id="tk-client-preview-step" class="tk-estimate-step" style="display: flex;">
        <div class="tk-complete-icon">🖥️</div>
        <div class="tk-complete-msg">Estimate written! Start client preview?</div>
        <button id="btn-tk-client-preview" class="btn-primary">Start Client Preview</button>
      </div>
    `;
    var btn = document.getElementById('btn-tk-client-preview');
    if (btn) {
      btn.addEventListener('click', async function () {
        btn.disabled = true;
        btn.textContent = 'Working…';
        try {
          // Find the BuilderTrend tab directly (mirrors startClientPreview logic)
          var tabs = await chrome.tabs.query({});
          var tab = tabs.find(function(t){ return t.url && t.url.includes('buildertrend') && t.url.toLowerCase().includes('estimate'); })
                 || tabs.find(function(t){ return t.url && t.url.includes('buildertrend'); });
          if (!tab) throw new Error('No BuilderTrend Estimate tab found.');

          // Call runClientPreviewFlow directly with a label setter on the workflow button
          if (typeof runClientPreviewFlow === 'function') {
            await runClientPreviewFlow(
              tab.id,
              function(msg) { console.log('[Workflow Preview]', msg); },
              function(label) { btn.textContent = label; }
            );
          }
          // Show final completion message
          var container = document.getElementById('tk-estimate-step-container');
          if (container) {
            container.innerHTML = `
              <div class="tk-estimate-step" style="display: flex;">
                <div class="tk-complete-icon">🎉</div>
                <div class="tk-complete-msg">Conceptual Estimate Complete!</div>
              </div>
            `;
          }
          wf.seqStep = 3; wf.seqMaxStep = 3; updateSeqNav();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Start Client Preview';
          if (typeof showStatus === 'function') showStatus('Client Preview failed: ' + e.message, 'error', 8000);
        }
      });
    }
  }

  function updateSeqNav() {
    var nav     = document.getElementById('tk-seq-nav');
    var backBtn = document.getElementById('btn-seq-back');
    var fwdBtn  = document.getElementById('btn-seq-forward');
    if (!nav) return;
    if (wf.seqMaxStep < 1) { nav.style.display = 'none'; return; }
    nav.style.display = 'flex';
    if (backBtn) backBtn.disabled = (wf.seqStep <= 0);
    if (fwdBtn)  fwdBtn.disabled  = (wf.seqStep >= wf.seqMaxStep);
  }

  function jumpToSeqStep(n) {
    wf.seqStep = n;
    var tkComplete  = document.getElementById('tk-complete');
    var container   = document.getElementById('tk-estimate-step-container');
    var writeBtn    = document.getElementById('btn-tk-write');
    if (n === 0) {
      if (tkComplete) tkComplete.classList.remove('hidden');
      if (writeBtn)   { writeBtn.style.display = ''; writeBtn.disabled = false; writeBtn.textContent = 'Grab & Write to Sheet'; }
      if (container)  container.innerHTML = '';
    } else if (n === 1) {
      if (tkComplete) tkComplete.classList.add('hidden');
      if (container) {
        container.innerHTML = buildEstimateStepHTML();
        wireDynamicEstimateButton();
      }
    } else if (n === 2) {
      if (tkComplete) tkComplete.classList.add('hidden');
      showClientPreviewCard();
    } else if (n === 3) {
      if (tkComplete) tkComplete.classList.add('hidden');
      if (container) container.innerHTML = `
        <div class="tk-estimate-step" style="display: flex;">
          <div class="tk-complete-icon">🎉</div>
          <div class="tk-complete-msg">Conceptual Estimate Complete!</div>
        </div>
      `;
    }
    updateSeqNav();
  }

  // ── Estimate step card HTML (shared by both insertion points) ────────────────
  function buildEstimateStepHTML() {
    return `
      <div id="tk-estimate-step" class="tk-estimate-step" style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="tk-complete-icon">📋</div>
          <div class="tk-complete-msg">Sheet saved! Write to estimate?</div>
        </div>

        <!-- Site Options dropdowns -->
        <div id="tk-site-options" style="display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;background:#f8fafc;">
          <div style="display:flex;flex-direction:column;gap:2px;">
            <label style="font-size:10px;color:#64748b;font-weight:600;">Sewer</label>
            <select id="tk-so-sewer" style="font-size:11px;padding:3px 5px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#1e293b;">
              <option value="">— None —</option>
              <option value="City (No Septic)">City (No Septic)</option>
              <option value="Conventional Septic">Conventional Septic</option>
              <option value="Engineered Septic">Engineered Septic</option>
            </select>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;">
            <label style="font-size:10px;color:#64748b;font-weight:600;">Water</label>
            <select id="tk-so-water" style="font-size:11px;padding:3px 5px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#1e293b;">
              <option value="">— City Water —</option>
              <option value="Well">Well</option>
            </select>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;">
            <label style="font-size:10px;color:#64748b;font-weight:600;">Municipal Tap Fees</label>
            <select id="tk-so-tap" style="font-size:11px;padding:3px 5px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#1e293b;">
              <option value="">— None —</option>
              <option value="None (Well/Septic)">None (Well/Septic)</option>
              <option value="Standard (12K)">Standard (12K)</option>
              <option value="High (18K)">High (18K)</option>
            </select>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;">
            <label style="font-size:10px;color:#64748b;font-weight:600;">Lot Clearing</label>
            <select id="tk-so-clearing" style="font-size:11px;padding:3px 5px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#1e293b;">
              <option value="">— None —</option>
              <option value="Light">Light</option>
              <option value="Moderate">Moderate</option>
              <option value="Heavy">Heavy</option>
            </select>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;">
            <label style="font-size:10px;color:#64748b;font-weight:600;">Driveway</label>
            <select id="tk-so-driveway" style="font-size:11px;padding:3px 5px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#1e293b;">
              <option value="">— None —</option>
              <option value="Short Gravel">Short Gravel</option>
              <option value="Standard (Gravel)">Standard (Gravel)</option>
              <option value="Long Gravel">Long Gravel</option>
              <option value="Asphalt">Asphalt</option>
            </select>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;">
            <label style="font-size:10px;color:#64748b;font-weight:600;">Landscaping</label>
            <select id="tk-so-landscaping" style="font-size:11px;padding:3px 5px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#1e293b;">
              <option value="">— None —</option>
              <option value="Basic">Basic</option>
              <option value="Standard">Standard</option>
              <option value="Extensive">Extensive</option>
            </select>
          </div>
        </div>

        <!-- Calculator -->
        <div id="tk-calc-section" style="border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;background:#f8fafc;">
          <div style="font-size:11px;font-weight:600;color:#64748b;margin-bottom:2px;letter-spacing:.03em;">CALCULATOR</div>
          <div style="font-size:10px;color:#94a3b8;margin-bottom:5px;">Formulas auto-save to history when you click out of the box</div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input id="tk-calc-input" type="text" placeholder="e.g. 12 * 8.5 + 200"
              style="flex:1;font-size:12px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;outline:none;font-family:monospace;">
            <button id="tk-calc-btn" style="font-size:12px;padding:5px 10px;border:none;border-radius:6px;background:#0ea5e9;color:#fff;cursor:pointer;white-space:nowrap;">=</button>
          </div>
          <div id="tk-calc-result" style="font-size:13px;font-weight:700;color:#0f172a;margin-top:5px;min-height:18px;"></div>
          <div style="position:relative;">
            <button id="tk-calc-history-btn" style="font-size:11px;color:#64748b;background:none;border:none;cursor:pointer;padding:2px 0;margin-top:2px;">▾ History</button>
            <div id="tk-calc-history-drop" style="display:none;position:absolute;left:0;top:100%;z-index:999;background:#fff;border:1px solid #e2e8f0;border-radius:7px;box-shadow:0 4px 12px rgba(0,0,0,.1);min-width:220px;max-height:180px;overflow-y:auto;padding:4px 0;"></div>
          </div>
        </div>

        <!-- Custom Selection Allowances -->
        <div id="tk-custom-section" style="border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;background:#f8fafc;">
          <div style="font-size:11px;font-weight:600;color:#64748b;margin-bottom:5px;letter-spacing:.03em;">CUSTOM SELECTION ALLOWANCES <span style="font-weight:400;color:#94a3b8;">(optional)</span></div>
          <div id="tk-custom-rows">
            <div class="tk-custom-row" style="display:flex;gap:5px;margin-bottom:4px;">
              <input class="tk-custom-name" type="text" placeholder="Item name…" style="flex:2;font-size:12px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;outline:none;">
              <span style="line-height:28px;color:#64748b;font-size:12px;">$</span>
              <input class="tk-custom-price" type="number" placeholder="0.00" min="0" step="0.01" style="flex:1;font-size:12px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;outline:none;">
            </div>
            <div class="tk-custom-row" style="display:flex;gap:5px;margin-bottom:4px;">
              <input class="tk-custom-name" type="text" placeholder="Item name…" style="flex:2;font-size:12px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;outline:none;">
              <span style="line-height:28px;color:#64748b;font-size:12px;">$</span>
              <input class="tk-custom-price" type="number" placeholder="0.00" min="0" step="0.01" style="flex:1;font-size:12px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;outline:none;">
            </div>
            <div class="tk-custom-row" style="display:flex;gap:5px;margin-bottom:4px;">
              <input class="tk-custom-name" type="text" placeholder="Item name…" style="flex:2;font-size:12px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;outline:none;">
              <span style="line-height:28px;color:#64748b;font-size:12px;">$</span>
              <input class="tk-custom-price" type="number" placeholder="0.00" min="0" step="0.01" style="flex:1;font-size:12px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;outline:none;">
            </div>
          </div>
          <button id="tk-add-custom-row" style="font-size:11px;color:#0ea5e9;background:none;border:none;cursor:pointer;padding:2px 0;margin-top:2px;">+ Add row</button>
        </div>

        <!-- Lender + Write button -->
        <label class="lender-toggle" title="Set Preferred Lender Incentive quantity to 1 in the estimate">
          <input type="checkbox" id="tk-chk-lender">
          <span class="lender-label">Preferred Lender Incentive</span>
        </label>
        <button id="btn-tk-write-estimate" class="btn-primary">Write to Estimate</button>
      </div>
    `;
  }

  function wireDynamicEstimateButton() {
    // ── Math parser (no eval / Function — blocked by MV3 CSP) ──────────────────
    // Supports: + - * / ^ % ( ) and sheet-style functions SQRT ROUND ABS INT
    function parseMath(str) {
      // strip leading = like Google Sheets
      var s = str.replace(/^\s*=\s*/, '').trim();
      // normalise: commas inside function calls → already handled per-function
      var pos = 0;

      function ws()  { while (pos < s.length && s[pos] === ' ') pos++; }
      function peek(){ ws(); return s[pos]; }
      function eat() { ws(); return s[pos++]; }

      function parseExpr()    { return parseAddSub(); }
      function parseAddSub() {
        var v = parseMulDiv(); ws();
        while (pos < s.length && (s[pos] === '+' || s[pos] === '-')) {
          var op = s[pos++]; v = op === '+' ? v + parseMulDiv() : v - parseMulDiv(); ws();
        }
        return v;
      }
      function parseMulDiv() {
        var v = parsePow(); ws();
        while (pos < s.length && (s[pos] === '*' || s[pos] === '/' || s[pos] === '%')) {
          var op = s[pos++];
          var r = parsePow();
          v = op === '*' ? v * r : op === '/' ? v / r : v % r; ws();
        }
        return v;
      }
      function parsePow() {
        var v = parseUnary(); ws();
        if (pos < s.length && s[pos] === '^') { pos++; v = Math.pow(v, parseUnary()); }
        return v;
      }
      function parseUnary() {
        ws();
        if (pos < s.length && s[pos] === '-') { pos++; return -parseAtom(); }
        if (pos < s.length && s[pos] === '+') { pos++; return parseAtom(); }
        return parseAtom();
      }
      function parseAtom() {
        ws();
        // parenthesised group
        if (pos < s.length && s[pos] === '(') {
          pos++;
          var v = parseExpr(); ws();
          if (pos < s.length && s[pos] === ')') pos++;
          return v;
        }
        // named functions (case-insensitive)
        var fnMatch = s.slice(pos).match(/^([A-Za-z_]\w*)\s*\(/);
        if (fnMatch) {
          var fname = fnMatch[1].toUpperCase();
          pos += fnMatch[0].length; // skip name + '('
          var args = [];
          ws();
          if (pos < s.length && s[pos] !== ')') {
            args.push(parseExpr()); ws();
            while (pos < s.length && (s[pos] === ',' || s[pos] === ';')) {
              pos++; args.push(parseExpr()); ws();
            }
          }
          if (pos < s.length && s[pos] === ')') pos++;
          switch (fname) {
            case 'SQRT':  return Math.sqrt(args[0]);
            case 'ABS':   return Math.abs(args[0]);
            case 'ROUND': return Math.round((args[0] || 0) * Math.pow(10, args[1] || 0)) / Math.pow(10, args[1] || 0);
            case 'INT':   return Math.trunc(args[0]);
            case 'MAX':   return Math.max.apply(null, args);
            case 'MIN':   return Math.min.apply(null, args);
            case 'SUM':   return args.reduce(function(a,b){return a+b;}, 0);
            case 'PI':    return Math.PI;
            default: throw new Error('Unknown function: ' + fname);
          }
        }
        // number literal
        var numRe = s.slice(pos).match(/^[0-9]*\.?[0-9]+/);
        if (numRe) { pos += numRe[0].length; return parseFloat(numRe[0]); }
        throw new Error('Unexpected: ' + (s[pos] || 'end'));
      }

      var result = parseExpr(); ws();
      if (pos < s.length) throw new Error('Unexpected: ' + s[pos]);
      if (!isFinite(result)) throw new Error('Result is not finite');
      return result;
    }

    // ── Calculator UI ───────────────────────────────────────────────────────────
    var CALC_STORAGE_KEY = 'tkCalcHistory';
    var EIGHT_HOURS_MS   = 8 * 60 * 60 * 1000;
    var calcHistory = [];  // in-memory mirror of what's in storage

    var calcInput  = document.getElementById('tk-calc-input');
    var calcResult = document.getElementById('tk-calc-result');
    var histBtn    = document.getElementById('tk-calc-history-btn');
    var histDrop   = document.getElementById('tk-calc-history-drop');

    var calcBtn = document.getElementById('tk-calc-btn');
    if (calcBtn) calcBtn.style.display = 'none';

    function tryEval(expr) {
      if (!expr || !expr.trim()) return null;
      try { return parseMath(expr); } catch(e) { return null; }
    }

    function saveHistory() {
      chrome.storage.local.set({ tkCalcHistory: calcHistory });
    }

    function loadHistory(cb) {
      chrome.storage.local.get(CALC_STORAGE_KEY, function(res) {
        var now = Date.now();
        var stored = res[CALC_STORAGE_KEY] || [];
        // Keep only entries from the last 8 hours
        calcHistory = stored.filter(function(h) { return (now - (h.ts || 0)) < EIGHT_HOURS_MS; });
        if (cb) cb();
      });
    }

    function commitCalc() {
      var expr = (calcInput.value || '').trim().replace(/^\s*=\s*/, '');
      if (!expr) return;
      var val = tryEval(expr);
      if (val === null) return;
      var rounded = Math.round(val * 10000) / 10000;
      // Skip duplicate of most recent entry
      if (calcHistory.length && calcHistory[0].expr === expr && calcHistory[0].val === rounded) return;
      calcHistory.unshift({ expr: expr, val: rounded, ts: Date.now() });
      if (calcHistory.length > 10) calcHistory.pop();
      saveHistory();
      renderHistory();
    }

    function updateLiveResult() {
      var expr = (calcInput.value || '').trim();
      if (!expr) { calcResult.textContent = ''; return; }
      var val = tryEval(expr);
      if (val !== null) {
        calcResult.textContent = '= ' + (Math.round(val * 10000) / 10000);
        calcResult.style.color = '#0f172a';
        calcResult.style.fontWeight = '700';
      } else {
        calcResult.textContent = '';
      }
    }

    function renderHistory() {
      if (!histDrop) return;
      histDrop.innerHTML = '';
      if (!calcHistory.length) {
        histDrop.innerHTML = '<div style="padding:6px 12px;font-size:11px;color:#94a3b8;">No history in the last 8 hours</div>';
        return;
      }
      calcHistory.forEach(function(h) {
        var item = document.createElement('div');
        item.style.cssText = 'padding:5px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid #f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        item.innerHTML = h.expr + ' = <b>' + h.val + '</b>';
        item.addEventListener('mouseenter', function(){ item.style.background = '#f0f9ff'; });
        item.addEventListener('mouseleave', function(){ item.style.background = ''; });
        item.addEventListener('click', function() {
          calcInput.value = String(h.val);
          updateLiveResult();
          histDrop.style.display = 'none';
        });
        histDrop.appendChild(item);
      });
    }

    // Load persisted history immediately so it's ready when user opens dropdown
    loadHistory(function() { /* pre-loaded, renderHistory called on dropdown open */ });

    if (calcInput) {
      calcInput.addEventListener('input', updateLiveResult);
      // Commit on Enter or on blur (clicking off)
      calcInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); commitCalc(); }
      });
      calcInput.addEventListener('blur', commitCalc);
    }
    if (histBtn) histBtn.addEventListener('click', function() {
      renderHistory();
      histDrop.style.display = histDrop.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', function(e) {
      if (histDrop && !histDrop.contains(e.target) && e.target !== histBtn) {
        histDrop.style.display = 'none';
      }
    }, { capture: true });

    // ── Add custom row button ───────────────────────────────────────────────────
    var addRowBtn = document.getElementById('tk-add-custom-row');
    if (addRowBtn) {
      addRowBtn.addEventListener('click', function() {
        var rowsEl = document.getElementById('tk-custom-rows');
        if (!rowsEl) return;
        var row = document.createElement('div');
        row.className = 'tk-custom-row';
        row.style.cssText = 'display:flex;gap:5px;margin-bottom:4px;';
        row.innerHTML = '<input class="tk-custom-name" type="text" placeholder="Item name…" style="flex:2;font-size:12px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;outline:none;">' +
          '<span style="line-height:28px;color:#64748b;font-size:12px;">$</span>' +
          '<input class="tk-custom-price" type="number" placeholder="0.00" min="0" step="0.01" style="flex:1;font-size:12px;padding:4px 7px;border:1px solid #cbd5e1;border-radius:6px;outline:none;">';
        rowsEl.appendChild(row);
      });
    }

    // ── Write to Estimate button ────────────────────────────────────────────────
    var tkWriteEstimateBtn = document.getElementById('btn-tk-write-estimate');
    if (!tkWriteEstimateBtn) return;

    tkWriteEstimateBtn.addEventListener('click', async function () {
      wf.allowEnterForEstimate = false;
      tkWriteEstimateBtn.disabled = true;
      tkWriteEstimateBtn.textContent = 'Reading sheet…';

      try {
        // Collect custom items (skip blank rows)
        var customItems = [];
        document.querySelectorAll('#tk-custom-rows .tk-custom-row').forEach(function(row) {
          var nameEl  = row.querySelector('.tk-custom-name');
          var priceEl = row.querySelector('.tk-custom-price');
          var name  = nameEl  ? (nameEl.value  || '').trim() : '';
          var price = priceEl ? parseFloat(priceEl.value) || 0 : 0;
          if (name) customItems.push({ name: name, unitCost: price });
        });

        // Read sheet cells (same as writeToEstimate in popup.js)
        var lender = document.getElementById('tk-chk-lender') && document.getElementById('tk-chk-lender').checked;
        var cells = await sendMsg('READ_CELLS_BATCH', {
          ranges: ['I13','D32','D46','D50','D56','D59','D62','D68','I9','I10','I11',
                   'I18','I19','I23','I24','I26',
                   'D86','D88','D89','D90','D91','D92','D93','D94','D99']
        });
        var c = cells.data;
        var n = function(v) { return parseFloat(String(v || '0').replace(/[^0-9.-]/g, '')) || 0; };

        var items = [
          { name: 'Total Fixed Cost',                                                    qty: 1 },
          { name: 'Total Finished SF & Unfinished (Under Roof)',                         qty: n(c['I13']) },
          { name: 'Total Finished SF',                                                   qty: n(c['D46']) },
          { name: 'Total Finished SF & Unfinished SF (Under Roof Excluding Porches)',    qty: n(c['D32']) },
          { name: 'Total Garage SF',                                                     qty: n(c['D62']) },
          { name: 'Total 1st Floor Finished, 1st Floor Unfinished & Garage',            qty: n(c['D56']) },
          { name: 'Total 1st Floor, Garage & Porch SF',                                 qty: n(c['D50']) },
          { name: 'Total Finished 1st Floor SF',                                         qty: n(c['D59']) },
          { name: 'Total for Decks & Porches',                                           qty: n(c['I9']) + n(c['I10']) + n(c['I11']) },
          { name: 'Interior Stairs',    qty: n(c['I23']) },
          { name: 'Exterior Doors',     qty: n(c['I18']) },
          { name: 'Windows',            qty: n(c['I19']) },
          { name: 'Porch Columns',      qty: n(c['I24']) },
          { name: 'Interior Doors',     qty: n(c['I26']) },
          { name: 'Garage Door',        qty: n(c['D68']) },
          { name: 'Number of Baths',    qty: n(c['D93']) },
          { name: 'Accessories Allowance',       qty: n(c['D86']) },
          { name: 'Appliance Allowance',         qty: 1 },
          { name: 'Cabinet Allowance',           qty: n(c['D88']) },
          { name: 'Carpet Allowance',            qty: n(c['D89']) },
          { name: 'Countertop Allowance',        qty: n(c['D90']) },
          { name: 'Hardwood Flooring Allowance', qty: n(c['D91']) },
          { name: 'Lighting Fixture Allowance',  qty: n(c['D92']) },
          { name: 'Plumbing Fixture Allowance',  qty: n(c['D93']) },
          { name: 'Tile Allowance',              qty: n(c['D94']) },
          { name: 'Clearing Allowance',    qty: 1 },
          { name: 'Driveway Allowance',    qty: 1 },
          { name: 'Landscaping Allowance', qty: n(c['D99']) },
          { name: 'Tap Fees',              qty: 1 },
        ];
        if (lender) items.push({ name: 'Preferred Lender Incentive', qty: 1 });

        // Read site option dropdowns (same as EXT_SITE_MAP in popup.js)
        var TK_SITE_MAP = {
          'tk-so-sewer': {
            'City (No Septic)':    { row: 2,  parentGroup: '11 - Septic/Sewer',           title: 'Sewer - City (No Septic)',          existingLine: null },
            'Conventional Septic': { row: 3,  parentGroup: '11 - Septic/Sewer',           title: 'Sewer - Conventional Septic',       existingLine: null },
            'Engineered Septic':   { row: 4,  parentGroup: '11 - Septic/Sewer',           title: 'Sewer - Engineered Septic',         existingLine: null },
          },
          'tk-so-water': {
            'Well':                { row: 6,  parentGroup: 'Well Allowance',               title: 'Water - Well',                      existingLine: null },
          },
          'tk-so-tap': {
            'None (Well/Septic)':  { row: 7,  parentGroup: '06 - Municipal Tap Fees',     title: 'Municipal Tap Fees - None (Well/Septic)', existingLine: 'Tap Fees' },
            'Standard (12K)':      { row: 8,  parentGroup: '06 - Municipal Tap Fees',     title: 'Municipal Tap Fees - Standard',     existingLine: 'Tap Fees' },
            'High (18K)':          { row: 9,  parentGroup: '06 - Municipal Tap Fees',     title: 'Municipal Tap Fees - High',         existingLine: 'Tap Fees' },
          },
          'tk-so-clearing': {
            'Light':               { row: 10, parentGroup: '09 - Lot Clearing/Site Prep', title: 'Lot Clearing - Light',              existingLine: 'Clearing Allowance' },
            'Moderate':            { row: 11, parentGroup: '09 - Lot Clearing/Site Prep', title: 'Lot Clearing - Moderate',           existingLine: 'Clearing Allowance' },
            'Heavy':               { row: 12, parentGroup: '09 - Lot Clearing/Site Prep', title: 'Lot Clearing - Heavy',              existingLine: 'Clearing Allowance' },
          },
          'tk-so-driveway': {
            'Short Gravel':        { row: 13, parentGroup: 'Driveway Allowance',           title: 'Driveway - Short Gravel',           existingLine: 'Driveway Allowance' },
            'Standard (Gravel)':   { row: 14, parentGroup: 'Driveway Allowance',           title: 'Driveway - Standard (Gravel)',      existingLine: 'Driveway Allowance' },
            'Long Gravel':         { row: 15, parentGroup: 'Driveway Allowance',           title: 'Driveway - Long Gravel',            existingLine: 'Driveway Allowance' },
            'Asphalt':             { row: 16, parentGroup: 'Driveway Allowance',           title: 'Driveway - Asphalt',               existingLine: 'Driveway Allowance' },
          },
          'tk-so-landscaping': {
            'Basic':               { row: 17, parentGroup: '62 - Landscaping',             title: 'Landscaping - Basic',               existingLine: 'Landscaping Allowance' },
            'Standard':            { row: 18, parentGroup: '62 - Landscaping',             title: 'Landscaping - Standard',            existingLine: 'Landscaping Allowance' },
            'Extensive':           { row: 19, parentGroup: '62 - Landscaping',             title: 'Landscaping - Extensive',           existingLine: 'Landscaping Allowance' },
          },
        };
        var selectedSiteItems = [];
        Object.keys(TK_SITE_MAP).forEach(function(id) {
          var el = document.getElementById(id);
          var val = el ? el.value : '';
          var map = TK_SITE_MAP[id];
          if (val && map && map[val]) {
            var entry = map[val];
            selectedSiteItems.push({ name: entry.title, row: entry.row, parentGroup: entry.parentGroup, existingLine: entry.existingLine || null });
          }
        });

        var siteOptions = [];
        if (selectedSiteItems.length) {
          var soResp = await sendMsg('READ_CELLS_RANGE_TAB', { tab: 'SITE OPTIONS', range: 'C2:C19' });
          var cRows = soResp.data || [];
          selectedSiteItems.forEach(function(item) {
            var rowData = cRows[item.row - 2];
            var unitCost = parseFloat(String((rowData && rowData[0]) || '0').replace(/[^0-9.-]/g, '')) || 0;
            siteOptions.push({ name: item.name, parentGroup: item.parentGroup, unitCost: unitCost, existingLine: item.existingLine });
          });
        }

        // Store in session and open tab picker
        await chrome.storage.session.set({ pendingEstimateItems: items, pendingCustomItems: customItems, pendingSiteOptions: siteOptions });
        await chrome.windows.create({
          url: chrome.runtime.getURL('tabpicker.html'),
          type: 'popup', width: 560, height: 520
        });

        // Transition to client preview card
        showClientPreviewCard();
        wf.seqStep = 2; wf.seqMaxStep = Math.max(wf.seqMaxStep, 2); updateSeqNav();

      } catch (e) {
        tkWriteEstimateBtn.disabled = false;
        tkWriteEstimateBtn.textContent = 'Write to Estimate';
        if (typeof showStatus === 'function') showStatus('Write to Estimate failed: ' + e.message, 'error', 8000);
      }
    });
  }

  // ── Init UI ───────────────────────────────────────────────────────────────────

  function initTakeoffPanel() {
    var startBtn        = document.getElementById('btn-start-takeoff');
    var doneBtn         = document.getElementById('btn-tk-done');
    var skipBtn         = document.getElementById('btn-tk-skip');
    var skipAllCountBtn = document.getElementById('btn-tk-skip-all-counts');
    var cancelBtn       = document.getElementById('btn-tk-cancel');
    var writeBtn        = document.getElementById('btn-tk-write');

    if (startBtn) startBtn.addEventListener('click', function () {
      if (!wf.active) runWorkflow();
    });

    var skipAllTakeoffsBtn = document.getElementById('btn-skip-all-takeoffs');
    if (skipAllTakeoffsBtn) skipAllTakeoffsBtn.addEventListener('click', function () {
      document.getElementById('tk-idle').classList.add('hidden');
      var tkComplete = document.getElementById('tk-complete');
      if (tkComplete) tkComplete.classList.remove('hidden');
      var writeBtn = document.getElementById('btn-tk-write');
      if (writeBtn) { writeBtn.style.display = ''; writeBtn.disabled = false; writeBtn.textContent = 'Grab & Write to Sheet'; }
      var container = document.getElementById('tk-estimate-step-container');
      if (container) container.innerHTML = '';
      wf.seqStep = 0; wf.seqMaxStep = 0; updateSeqNav();
    });

    var seqBackBtn = document.getElementById('btn-seq-back');
    var seqFwdBtn  = document.getElementById('btn-seq-forward');
    if (seqBackBtn) seqBackBtn.addEventListener('click', function () {
      if (wf.seqStep > 0) jumpToSeqStep(wf.seqStep - 1);
    });
    if (seqFwdBtn) seqFwdBtn.addEventListener('click', function () {
      if (wf.seqStep < wf.seqMaxStep) jumpToSeqStep(wf.seqStep + 1);
    });

    // ── DEBUG: Watch tk-estimate-step-container for unexpected mutations ──────
    var debugContainer = document.getElementById('tk-estimate-step-container');
    if (debugContainer) {
      var debugObserver = new MutationObserver(function(mutations) {
        mutations.forEach(function(m) {
          if (m.type === 'childList' || m.type === 'characterData') {
            console.log('[DUKE DEBUG] tk-estimate-step-container changed!');
            console.log('[DUKE DEBUG] innerHTML now:', debugContainer.innerHTML.slice(0, 200));
            console.log('[DUKE DEBUG] Stack trace:', new Error('mutation source').stack);
          }
        });
      });
      debugObserver.observe(debugContainer, { childList: true, subtree: true, characterData: true });
      console.log('[DUKE DEBUG] MutationObserver attached to tk-estimate-step-container');
    } else {
      console.warn('[DUKE DEBUG] tk-estimate-step-container NOT FOUND in DOM!');
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (doneBtn) doneBtn.addEventListener('click', function () {
      if (wf.userResolve) { var r = wf.userResolve; wf.userResolve = null; r('done'); }
    });

    if (skipBtn) skipBtn.addEventListener('click', function () {
      // Abort any in-flight scale AI fetch immediately
      if (typeof scaleAbortCtrl !== 'undefined' && scaleAbortCtrl) {
        scaleAbortCtrl.abort();
      }
      // Cancel AI page naming in the content script (closes modal, stops mid-flight)
      if (wf.stTabId) {
        chrome.tabs.sendMessage(wf.stTabId, { action: 'CANCEL_AI_PAGE_NAMES' }, { frameId: 0 }, function () {});
      }
      if (wf.userResolve) { var r = wf.userResolve; wf.userResolve = null; r('skip'); }
      else if (wf.skipResolve) { var s = wf.skipResolve; wf.skipResolve = null; s('skip'); }
    });

    if (skipAllCountBtn) skipAllCountBtn.addEventListener('click', function () {
      wf.skipAllCounts = true;
      // Also resolve any pending waitForUser so the current count step exits
      if (wf.userResolve) { var r = wf.userResolve; wf.userResolve = null; r('skip'); }
      skipAllCountBtn.classList.add('hidden');
    });

    if (cancelBtn) cancelBtn.addEventListener('click', function () {
      if (wf.userResolve) { var r = wf.userResolve; wf.userResolve = null; r('cancel'); }
      // If cancel is pressed while the estimate step is showing, reset it cleanly
      wf.allowEnterForEstimate = false;
      var tkEstimateContainer = document.getElementById('tk-estimate-step-container');
      if (tkEstimateContainer) tkEstimateContainer.innerHTML = '';
      // Restore the write-to-sheet button if it was hidden by the estimate step
      var writeBtn = document.getElementById('btn-tk-write');
      if (writeBtn) { writeBtn.style.display = ''; writeBtn.disabled = false; }
      if (wf.active) {
        wf.active = false;
        document.getElementById('tk-active').classList.add('hidden');
        document.getElementById('tk-idle').classList.remove('hidden');
        if (typeof showStatus === 'function') showStatus('Takeoff cancelled', 'info', 3000);
      }
    });

    if (writeBtn) writeBtn.addEventListener('click', workflowWriteToSheet);

    // Block Enter from firing #btn-write-estimate (the always-visible button) except
    // when we are in the workflow estimate step (wf.allowEnterForEstimate === true).
    var persistentWriteEstimateBtn = document.getElementById('btn-write-estimate');
    if (persistentWriteEstimateBtn) {
      persistentWriteEstimateBtn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !wf.allowEnterForEstimate) {
          e.preventDefault();
        }
      });
    }

    // Enter key in the panel:
    //   • If the workflow Done button is visible → click it.
    //   • Else if we're in the post-write-to-sheet estimate step → click the workflow estimate button.
    //   • Otherwise swallow Enter so it can never accidentally fire the persistent Write to Estimate.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (e.ctrlKey) return; // Ctrl+Enter handled by content script restart logic
      var done = document.getElementById('btn-tk-done');
      if (done && !done.classList.contains('hidden') && !done.disabled) {
        e.preventDefault();
        done.click();
        return;
      }
      if (wf.allowEnterForEstimate) {
        var tkWE = document.getElementById('btn-tk-write-estimate');
        if (tkWE && !tkWE.disabled) {
          e.preventDefault();
          tkWE.click();
        }
        return;
      }
      // Allow Enter to trigger Start Client Preview when that card is visible
      var tkCP = document.getElementById('btn-tk-client-preview');
      if (tkCP && !tkCP.disabled) {
        e.preventDefault();
        tkCP.click();
        return;
      }
      // Neither active step is waiting for Enter — prevent stray Enter from
      // triggering any focused button (e.g. the persistent Write to Estimate).
      e.preventDefault();
    });

    // Listen for Enter notifications from SquareTakeoff content script
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg.action === 'TAKEOFF_ENTER_PRESSED' && wf.userResolve) {
        var r = wf.userResolve; wf.userResolve = null; r('done');
      }
      if (msg.action === 'TAKEOFF_CTRL_ENTER_PRESSED' && wf.userResolve) {
        var r = wf.userResolve; wf.userResolve = null; r('restart');
      }
    });
  }

  // Boot after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTakeoffPanel);
  } else {
    initTakeoffPanel();
  }

  // Expose for the dropdown "Grab & Write to Sheet" button in popup.js
  window._tkWriteToSheet = workflowWriteToSheet;
  window._tkWf = wf;

})();
