// Keel EZ Estimate - Popup Script (clean rewrite)

// ── Helpers ───────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showStatus(msg, type, duration) {
  type = type || 'info'; duration = duration === undefined ? 3500 : duration;
  const bar = $('status-bar');
  bar.textContent = msg;
  bar.className = 'status-bar ' + type;
  bar.classList.remove('hidden');
  if (duration > 0) setTimeout(function() { bar.classList.add('hidden'); }, duration);
}

function sendMsg(action, data) {
  data = data || {};
  return new Promise(function(resolve, reject) {
    chrome.runtime.sendMessage(Object.assign({ action: action }, data), function(res) {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!res || !res.ok) { reject(new Error((res && res.error) || 'Unknown error')); return; }
      resolve(res);
    });
  });
}

// ── Unit costs (Supabase cost_items / house_rates) ──────────────────────────────
// Shared by writeToEstimate() below and takeoff-workflow.js's own copy
// (same duplication pattern as EXT_SITE_MAP/TK_SITE_MAP elsewhere in this
// codebase — each surface is a standalone copy, not a shared import).

const SUPABASE_URL_UC = 'https://fujddlemswhbdqrhpekt.supabase.co';
const SUPABASE_ANON_UC = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1amRkbGVtc3doYmRxcmhwZWt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzMTYzODcsImV4cCI6MjA5OTg5MjM4N30.pR2IINeUB6RDAXBG6IDHrLc3diW8TNYYN1jAIEdXFm4';

// The BuilderTrend line-item titles this automation searches for (used
// throughout popup.js/takeoff-workflow.js/tabpicker.js) don't all match
// cost_items.item_name exactly — the Sheet used slightly different plural/
// short forms when that table was first seeded. Bridges the ones that differ.
const ITEM_NAME_TO_COST_ITEM_NAME = {
  'Appliance Allowance': 'Appliances Allowance',
  'Cabinet Allowance': 'Cabinets Allowance',
  'Carpet Allowance': 'Carpets Allowance',
  'Countertop Allowance': 'Counterop Allowance',
  'Hardwood Flooring Allowance': 'Hardwood Allowance',
  'Tile Allowance': 'Tile Selection Allowance',
  'Garage Door': 'Garage Overhead Doors'
};

// Separate from the map above on purpose: these 6 subtotal labels have no
// cost_items row of their own, and the "proxy" item each maps to is only
// valid for borrowing its QUANTITY (both happen to equal the same group
// square footage) — its unit cost is a completely different, unrelated
// number and must never be looked up this way. Mixing this into
// ITEM_NAME_TO_COST_ITEM_NAME would make fetchUnitCostsFromSupabase()
// silently write e.g. Drywall's $/SF rate onto "Total Finished SF"'s line.
// Sheet's subtotal rows never carry a quantity at all — only their own
// $0.00 Amount column is populated (confirmed live) — hence needing a
// proxy in the first place. Chosen by matching each label's stated
// meaning to a specific item's actual formula, not by row proximity —
// child rows in the same group can have genuinely different formulas that
// only coincidentally produce the same number for whichever job happens
// to be loaded (confirmed this varies).
const QUANTITY_ITEM_NAME_TO_COST_ITEM_NAME = {
  'Total Finished SF': 'Drywall',                                                    // =$I$4+$I$5+$I$6 (all finished floors)
  'Total Finished SF & Unfinished SF (Under Roof Excluding Porches)': 'Siding Labor/ Siding Turnkey', // =$I$4+$I$5+$I$6+$I$12
  'Total 1st Floor, Garage & Porch SF': 'Roofing',                                    // =$I$4+$I$12+$I$9+$I$10
  'Total 1st Floor Finished, 1st Floor Unfinished & Garage': 'Stone/ Gravel',         // =$I$4+$I$12
  'Total Finished 1st Floor SF': 'Insulation Crawlspace',                             // =$I$4
  'Total Garage SF': 'Concrete Flatwork Turnkey'                                      // =$I$12
};

// Everything below used to be a hardcoded Sheet D-cell number that drifted
// out of alignment when rows shifted (several ended up blank/0, since
// they'd landed on a subtotal row that never carries a quantity at all).
// All of it now comes from Supabase's quantity_formula instead (see
// evaluateQuantityFormula above), which only ever references I-cells — the
// fixed-position raw-measurement table that does not move when the item
// list grows or shrinks below it.
const QUANTITY_FROM_FORMULA_ITEMS = [
  'Accessories Allowance', 'Appliance Allowance', 'Cabinet Allowance', 'Carpet Allowance',
  'Countertop Allowance', 'Hardwood Flooring Allowance', 'Lighting Fixture Allowance',
  'Plumbing Fixture Allowance', 'Tile Allowance', 'Landscaping Allowance', 'Garage Door',
  'Total Finished SF', 'Total Finished SF & Unfinished SF (Under Roof Excluding Porches)',
  'Total 1st Floor, Garage & Porch SF', 'Total 1st Floor Finished, 1st Floor Unfinished & Garage',
  'Total Finished 1st Floor SF', 'Total Garage SF'
];

// Returns { itemName: unitCost | undefined }. unitCost is undefined for any
// name with no matching cost_items row — callers must treat that as "leave
// BuilderTrend's existing rate alone", never as "write zero".
//
// selectedHouseKey: null → average every house_rates row flagged
// include_in_average=true for that item (the Custom-Plan-style number).
// A house key (e.g. 'kiawah') → that house's own rate only, no averaging —
// used when a base plan was selected, since you're reconstructing a real
// house's actual numbers, not a blend.
async function fetchUnitCostsFromSupabase(itemNames, selectedHouseKey) {
  console.log('[Keel][unitcost] fetchUnitCostsFromSupabase called with selectedHouseKey=' + JSON.stringify(selectedHouseKey) + ', ' + itemNames.length + ' item(s):', itemNames);

  const lookupNames = itemNames.map(function(n) { return ITEM_NAME_TO_COST_ITEM_NAME[n] || n; });
  const uniqueNames = Array.from(new Set(lookupNames));
  const inList = uniqueNames.map(function(n) { return '"' + n.replace(/"/g, '\\"') + '"'; }).join(',');

  const params = new URLSearchParams();
  params.set('select', 'id,item_name,house_rates(house,amount,quantity,include_in_average)');
  params.set('item_name', 'in.(' + inList + ')');

  const url = SUPABASE_URL_UC + '/rest/v1/cost_items?' + params.toString();
  let res;
  try {
    res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_UC, Authorization: 'Bearer ' + SUPABASE_ANON_UC }
    });
  } catch (networkErr) {
    console.error('[Keel][unitcost] fetch() itself threw (network/CSP/offline?) for URL:', url, networkErr);
    throw networkErr;
  }
  if (!res.ok) {
    const bodyText = await res.text();
    console.error('[Keel][unitcost] Supabase returned HTTP ' + res.status + ' for URL:', url, 'body:', bodyText);
    throw new Error('Supabase cost_items read failed (' + res.status + '): ' + bodyText);
  }
  const rows = await res.json();
  console.log('[Keel][unitcost] Supabase returned ' + rows.length + ' cost_items row(s) for ' + uniqueNames.length + ' requested name(s)');

  const byLookupName = {};
  rows.forEach(function(r) { byLookupName[r.item_name] = r; });

  const result = {};
  let resolvedCount = 0, noRowCount = 0, noRateCount = 0;
  itemNames.forEach(function(originalName) {
    const lookupName = ITEM_NAME_TO_COST_ITEM_NAME[originalName] || originalName;
    const row = byLookupName[lookupName];
    if (!row) { result[originalName] = undefined; noRowCount++; return; }
    const rates = row.house_rates || [];
    function unitCostOf(hr) { return (hr.quantity > 0) ? (hr.amount / hr.quantity) : (hr.amount || 0); }

    if (selectedHouseKey) {
      const hr = rates.find(function(h) { return h.house === selectedHouseKey; });
      if (!hr) {
        console.warn('[Keel][unitcost] "' + originalName + '" (cost_items name "' + lookupName + '") has no house_rates row for house="' + selectedHouseKey + '" — houses present: ' + rates.map(function(h){return h.house;}).join(','));
        noRateCount++;
      }
      result[originalName] = hr ? unitCostOf(hr) : undefined;
    } else {
      const included = rates.filter(function(h) { return h.include_in_average; });
      if (!included.length) {
        console.warn('[Keel][unitcost] "' + originalName + '" (cost_items name "' + lookupName + '") has ZERO house_rates rows with include_in_average=true out of ' + rates.length + ' total — averaging is impossible for this item.', rates);
        noRateCount++;
        result[originalName] = undefined;
        return;
      }
      const sum = included.reduce(function(s, h) { return s + unitCostOf(h); }, 0);
      result[originalName] = sum / included.length;
    }
    if (result[originalName] !== undefined) resolvedCount++;
  });
  console.log('[Keel][unitcost] result: ' + resolvedCount + ' resolved, ' + noRowCount + ' had no matching cost_items row, ' + noRateCount + ' had no usable house_rates row');
  return result;
}

// Quantities from Supabase cost_items.quantity_formula, instead of a
// hardcoded D-cell number on the Sheet. This exists because the Sheet's
// item rows have shifted over time (a new row inserted before an
// allowance, etc.) and every hardcoded "D86", "D88"... reference quietly
// went stale — the exact bug this fixes. quantity_formula text only ever
// references I-cells (e.g. "=$I$4+$I$5+$I$6" or "=I21") — the fixed-
// position raw-measurement mini-table, which does NOT shift when rows are
// inserted/removed further down in the item list — so evaluating it
// directly is immune to that drift entirely, not just a one-time patch.
//
// cellValues: a plain object of already-read cell values keyed like
// {'I4': '1234', 'I21': '33', ...} — either straight from READ_CELLS_BATCH
// (regular flow) or from the base-plan's own {areaKeys/countKeys: value}
// object translated to I-refs (see takeoff-workflow.js's base-plan flow).
function evaluateQuantityFormula(formula, cellValues) {
  const n = function(v) { return parseFloat(String(v || '0').replace(/[^0-9.-]/g, '')) || 0; };
  const f = (formula || '').trim();
  if (f === '') return 0;
  if (f.charAt(0) !== '=') { const num = Number(f); return isFinite(num) ? num : 0; }
  const body = f.slice(1);
  let total = 0;
  let m;
  const re = /\$?I\$?(\d+)/g;
  while ((m = re.exec(body)) !== null) {
    total += n(cellValues['I' + m[1]]);
  }
  return total;
}

function quantityLookupName(originalName) {
  // Quantity-only proxy names take priority — they exist specifically
  // because these 6 labels have no cost_items row of their own at all.
  return QUANTITY_ITEM_NAME_TO_COST_ITEM_NAME[originalName] || ITEM_NAME_TO_COST_ITEM_NAME[originalName] || originalName;
}

async function fetchQuantityFormulasFromSupabase(itemNames) {
  const lookupNames = itemNames.map(quantityLookupName);
  const uniqueNames = Array.from(new Set(lookupNames));
  const inList = uniqueNames.map(function(n) { return '"' + n.replace(/"/g, '\\"') + '"'; }).join(',');

  const params = new URLSearchParams();
  params.set('select', 'item_name,quantity_formula');
  params.set('item_name', 'in.(' + inList + ')');

  const res = await fetch(SUPABASE_URL_UC + '/rest/v1/cost_items?' + params.toString(), {
    headers: { apikey: SUPABASE_ANON_UC, Authorization: 'Bearer ' + SUPABASE_ANON_UC }
  });
  if (!res.ok) throw new Error('Supabase cost_items read failed (' + res.status + '): ' + await res.text());
  const rows = await res.json();

  const byLookupName = {};
  rows.forEach(function(r) { byLookupName[r.item_name] = r.quantity_formula; });

  const result = {};
  itemNames.forEach(function(originalName) {
    result[originalName] = byLookupName[quantityLookupName(originalName)]; // undefined if no match — caller must not guess
  });
  return result;
}

// ── AI Constants ──────────────────────────────────────────────────────────────

const AI_LABELS = {
  exterior_doors: '# Exterior Doors',
  windows:        '# Windows',
  baths:          '# Baths',
  staircases:     '# Staircases',
  porch_columns:  '# Porch Columns',
  garage_doors:   '# Garage Doors',
  interior_doors: '# Interior Doors',
};

const AI_KEY_MAP = {
  exterior_doors: '# of exterior doors',
  windows:        '# of windows',
  baths:          '# of baths',
  staircases:     '# of staircases',
  porch_columns:  '# of front porch columns',
  garage_doors:   '# of garage doors',
  interior_doors: '# of interior doors',
};

let lastAiResult    = null;
let lastImageBase64 = null;
let lastImageMime   = null;

let lastReasoning   = null; // full GPT-4o text before the JSON
// ── GPT-4o Two-Pass Analysis ──────────────────────────────────────────────────

function gptCall(openaiKey, systemPrompt, userContent, maxTokens) {
  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + openaiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: maxTokens || 4096,
      temperature: 0,          // deterministic — same image = same answer every time
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  }
      ]
    })
  }).then(function(res) {
    if (!res.ok) return res.json().then(function(e) {
      throw new Error('OpenAI ' + res.status + ': ' + ((e && e.error && e.error.message) || res.statusText));
    });
    return res.json();
  }).then(function(d) {
    return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
  });
}

// imgs: array of base64 strings OR {base64, mime} objects
function buildImageContent(imgs) {
  const c = [];
  imgs.forEach(function(img, i) {
    const b64  = (typeof img === 'string') ? img : img.base64;
    const mime = (typeof img === 'string') ? 'image/png' : (img.mime || 'image/png');
    if (imgs.length > 1) c.push({ type: 'text', text: 'Page ' + (i + 1) + ':' });
    c.push({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64, detail: 'high' } });
  });
  return c;
}

async function pass1Count(imgs, key) {
  const SYS = 'You are a construction estimator. Count exactly: # of exterior doors, # of windows, # of baths, # of staircases, # of front porch columns, # of garage doors, # of interior doors. Be specific and show your reasoning.\n\nDoor rules: one arc = 1 door. Two arcs same opening = 2 doors. Hand-drawn arcs count. Exterior = outer wall. Interior = between rooms. Garage overhead = separate category.\n\nAfter your reasoning end with this JSON on its own line:\n{"exterior_doors":N,"windows":N,"baths":N,"staircases":N,"porch_columns":N,"garage_doors":N,"interior_doors":N}';
  const content = [{ type: 'text', text: 'Count all elements. Show reasoning then give the JSON.' }].concat(buildImageContent(imgs));
  const text = await gptCall(key, SYS, content, 2000);
  console.log('[Keel P1]', text);
  const m = text.match(/\{"exterior_doors":\s*\d[^}]*\}/);
  if (!m) throw new Error('Count pass failed. Response: ' + text.slice(0, 300));
  return JSON.parse(m[0]);
}

async function pass2Locate(imgs, key, counts) {
  const summary = Object.entries(counts).map(function(e) { return e[1] + ' ' + e[0].replace(/_/g, ' '); }).join(', ');
  const SYS = 'You are annotating a floor plan. Verified counts: ' + summary + '.\n\nFor each element give the x,y location of EVERY instance as a percentage of the image (0,0=top-left, 100,100=bottom-right). Place each point directly ON the symbol itself.\n\nReturn ONLY valid JSON, no other text:\n{"exterior_doors":{"count":' + counts.exterior_doors + ',"locations":[]},"windows":{"count":' + counts.windows + ',"locations":[]},"baths":{"count":' + counts.baths + ',"locations":[]},"staircases":{"count":' + counts.staircases + ',"locations":[]},"porch_columns":{"count":' + counts.porch_columns + ',"locations":[]},"garage_doors":{"count":' + counts.garage_doors + ',"locations":[]},"interior_doors":{"count":' + counts.interior_doors + ',"locations":[]}}';
  const content = [{ type: 'text', text: 'Locate all ' + summary + '. Return JSON.' }].concat(buildImageContent(imgs));
  const text = await gptCall(key, SYS, content, 4096);
  console.log('[Keel P2]', text.slice(0, 150));
  const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Location pass failed. Response: ' + text.slice(0, 200));
  const r = JSON.parse(m[0]);
  Object.keys(counts).forEach(function(k) { if (r[k]) r[k].count = counts[k]; });
  return r;
}

// ── Few-shot training examples ────────────────────────────────────────────────
// Loads verified floor plan images from extension bundle as base64

async function loadTrainingImage(filename) {
  const url = chrome.runtime.getURL('training/' + filename);
  const res  = await fetch(url);
  const blob = await res.blob();
  return new Promise(function(resolve) {
    const reader = new FileReader();
    reader.onload = function(e) { resolve(e.target.result.split(',')[1]); };
    reader.readAsDataURL(blob);
  });
}

// Returns few-shot messages array to prepend to every analysis call
// Each example = [user message with images] + [assistant message with correct reasoning + JSON]
async function buildFewShotMessages() {
  try {
    const [kf1, kf2, bf1, bf2] = await Promise.all([
      loadTrainingImage('kiawah_floor1.jpg'),
      loadTrainingImage('kiawah_floor2.jpg'),
      loadTrainingImage('bonaire_floor1.png'),
      loadTrainingImage('bonaire_floor2.png'),
    ]);

    return [
      // ── KIAWAH EXAMPLE ──
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Walk through this floor plan room by room, count every element, then output the JSON.' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + kf1, detail: 'low' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + kf2, detail: 'low' } }
        ]
      },
      {
        role: 'assistant',
        content: 'KIAWAH: Ext Doors=3 (covered porch + front entry + garage man-door), Windows=27 (16 floor1+11 floor2), Baths=3.5 (Bath2+PWDR on floor1, PrimaryBath1+Bath3 on floor2), Stairs=1 (UP in foyer), Columns=2 (porch corners), Garage=1 (OHD in 2-CAR GARAGE), Int Doors=27 (11 floor1+16 floor2).\n\n{"exterior_doors":{"count":3,"locations":[]},"windows":{"count":27,"locations":[]},"baths":{"count":3.5,"locations":[]},"staircases":{"count":1,"locations":[]},"porch_columns":{"count":2,"locations":[]},"garage_doors":{"count":1,"locations":[]},"interior_doors":{"count":27,"locations":[]}}'
      },

      // ── BONAIRE EXAMPLE ──
      {
        role: "user",
        content: [
          { type: "text", text: "Walk through this floor plan room by room, count every element, then output the JSON." },
          { type: "image_url", image_url: { url: "data:image/png;base64," + bf1, detail: "low" } },
          { type: "image_url", image_url: { url: "data:image/png;base64," + bf2, detail: "low" } }
        ]
      },
      {
        role: "assistant",
        content: "This is the BONAIRE plan specifically. BONAIRE counts: Ext Doors=4 (2 arcs at front entry porch + 2 arcs at rear covered porch), Windows=22 (15 floor1 + 7 floor2), Baths=3.5, Stairs=1, Columns=7 (specific to this plan's porch), Garage=1, Int Doors=26. These numbers are ONLY for Bonaire — other plans will differ.\n\n{\"exterior_doors\":{\"count\":4,\"locations\":[]},\"windows\":{\"count\":22,\"locations\":[]},\"baths\":{\"count\":3.5,\"locations\":[]},\"staircases\":{\"count\":1,\"locations\":[]},\"porch_columns\":{\"count\":7,\"locations\":[]},\"garage_doors\":{\"count\":1,\"locations\":[]},\"interior_doors\":{\"count\":26,\"locations\":[]}}"
      },
    ];
  } catch (e) {
    console.warn('[Keel] Could not load training images:', e.message);
    return []; // fall back to no few-shot if images fail to load
  }
}

// ── Core GPT-4o analysis ──────────────────────────────────────────────────────

const ANALYSIS_SYSTEM = `You are a professional residential construction estimator analyzing floor plan drawings. Count only what you can visually see in the image. Do not assume or infer based on room type — count only the actual symbols present.

SYMBOL IDENTIFICATION
─────────────────────
WALL: thick double parallel lines forming the building perimeter or interior room dividers.
DIMENSION LINE: thin single line with arrows and a measurement number (e.g. 18'-11½"). IGNORE these — they are not walls.

WINDOW SYMBOL: a gap in a wall with 2–3 thin parallel lines inside the gap. NO arc attached.
DOOR SYMBOL: same wall gap WITH a quarter-circle arc (pie-slice/fan shape) showing the door swing. The arc is the key difference from a window.
- Gap + parallel lines + NO arc = WINDOW
- Gap + parallel lines + arc = DOOR
- Hand-drawn version: the arc may be rough or imperfect but is still an arc shape
- Double door (Z or mirrored-arc shape): two arcs at one opening = 2 doors

COLUMN SYMBOL: small solid filled black square positioned inside a porch area.
GARAGE OVERHEAD DOOR: large dashed/dotted rectangle spanning the full garage opening, often labeled OHD or with dimensions like 16080.
STAIRCASE: parallel step lines with an UP or DN arrow.
TOILET: oval/rectangle with small tank rectangle at one end.
BATHTUB: large oval or rectangle with inner oval, sometimes diagonal line.
SHOWER: rectangle with dashed X or diagonal lines.

COUNTING RULES
─────────────────────

EXTERIOR DOORS
- Exterior doors are ANY door arc on a wall that separates an interior room from an outdoor space: covered porch, entry porch, rear porch, deck, or directly outside. They are NOT limited to the outer building perimeter — porches can be inside the roofline.
- COUNT EACH INDIVIDUAL DOOR ARC. Do NOT count porch areas — count door openings. If a porch has 2 separate door arcs leading to it, count 2 exterior doors, not 1.
- A pair of french doors (two arcs side by side at one porch opening) = 2 exterior doors.
- A single door at one porch opening = 1 exterior door.
- Check EVERY porch on the plan: covered porch, entry porch, rear porch, side porch. Each may have 1 or 2 door arcs — do NOT assume every porch has 2.
- CAD PLANS: Find every door size code on a wall adjacent to a porch/outdoor space.
- HAND-DRAWN PLANS: Count every door arc on walls adjacent to porch or exterior spaces.
- Do NOT count garage overhead doors. Do NOT count interior-to-interior doors.

WINDOWS
- CAD PLANS: Look for window size codes printed next to wall openings on EXTERIOR walls only. Common codes: 3060, 3040, 2040, 3030, 2640, 3050, 4040, 2030, 2438, etc. Count each code = 1 window.
- TWIN or DOUBLE windows (labeled "TWIN 3060", "TWO8 3060", "DOUBLE", or similar): count as 1 window — one opening regardless of pane count.
- Count windows on ALL exterior walls including garage walls and basement walls.
- EXHAUSTIVE METHOD — name every room that touches an exterior wall, then count the window codes on that room's exterior wall(s). Do this for EVERY room on EVERY floor before summing. Large houses have 20–30+ windows across 2 floors.
- SECOND FLOOR WARNING: The 2nd floor almost always has FEWER windows than the 1st floor. If you count more 2nd floor windows than 1st floor windows, you are almost certainly miscounting — recheck.
- Do NOT count codes in schedule/legend tables. Do NOT count door size codes (door codes sit INSIDE an arc; window codes are next to a wall gap with no arc).
- After counting, if your total is under 15 for a large 2-story house, you missed rooms — go back and check every exterior-wall room again.

BATHS
BATHS
- Count ONLY rooms you can explicitly see labeled as a bath. Do NOT infer a room exists because a similarly-numbered room exists (e.g. do not assume 'Bath 1' exists just because 'Bath 2' is labeled).
- POWDER / PWDR / HALF BATH = 0.5. BATH 2 / BATH 3 / PRIMARY BATH / MASTER BATH = 1.0 each.
- Unlabeled room with toilet + tub or shower = 1.0. Toilet + sink only = 0.5.
- List every bath room you can see labeled, then add their values. Do not add rooms you cannot see.

STAIRCASES
STAIRCASES
- Before counting: ask yourself TWO questions: (1) Is this stair symbol fully inside the building floor plan, away from exterior walls? (2) Does it have 10 or more step lines with a high number like UP 14, UP 16, DN 12?
- If NO to either question, count = 0.
- INTERIOR stairs look like: a rectangular grid of many small rectangles (two rows of box shapes), labeled UP or DN with a high number (12+), inside the building.
- EXTERIOR steps look like: a simple 3-5 line rectangle AT THE BUILDING PERIMETER next to an exterior door, labeled DN with no number or a small number.
- If you are unsure whether stairs are interior or exterior, count 0.

FRONT PORCH COLUMNS
- Count ONLY the small solid filled black square symbols you can actually see. Do NOT guess or assume a number based on any pattern.
- Columns appear at porch corners, along porch edges, and sometimes in a row along the front face of steps. Count what is VISIBLE — some plans have 2, others 7, others 12.
- Trace the ENTIRE perimeter of every porch area on the plan (entry porch, covered porch, front porch, rear porch, side porch).
- Count each individual square separately — a cluster of 4 = 4 columns.
- Do NOT count general wall corners or structural wall intersections — only the small isolated squares clearly within porch areas.
GARAGE OVERHEAD DOORS
- HARD RULE: You must be able to READ the word GARAGE on the plan. Spell it out — G-A-R-A-G-E. If you cannot find and read that word, count = 0.
- If you CAN read GARAGE, also look for a dashed rectangle inside that room. Both required.
- Never assume a garage exists. Never count 1 unless you can read the word GARAGE.
- CAD PLANS: Count every door size code (2868, 3068, 2668, 2468, 2068, 1668, etc.) printed inside the arc sweep of door symbols inside the building.
- Each code inside an arc = 1 door. The code sits INSIDE the quarter-circle fan shape.
- Include closet doors, WIC doors, WC doors, shower doors, linen closet doors — every arc with a code counts.
- Primary Bath: look for multiple codes — each sub-space (WC, shower, linen closet, WIC) has its own arc with its own code.
- CASED OPENING: any opening labeled "CASED OPENING" or "CO" on the plan is NOT a door — do not count it. These are open archways with no door. If you count one, your total will be too high by 1.
- Do NOT count codes in door schedule/legend tables.
- Do NOT count exterior doors (those are on walls leading to porches/outside).
- HAND-DRAWN PLANS: Count every arc symbol inside the building on interior walls only. Before finalizing, subtract any openings labeled "CASED OPENING".
- Count both floors separately and add.

SECOND FLOOR WINDOWS: [same]
TOTAL WINDOWS: [sum]

FIRST FLOOR INTERIOR DOORS: [list each room and arc count seen]
SECOND FLOOR INTERIOR DOORS: [same]
TOTAL INTERIOR DOORS: [sum]

[same breakdown for all other categories]

Then end with ONLY this JSON on its own line:
{"exterior_doors":0,"windows":0,"baths":0,"staircases":0,"porch_columns":0,"garage_doors":0,"interior_doors":0}

REFERENCE COUNTS from verified plans:
KIAWAH: Ext Doors=3, Windows=27, Baths=3.5, Stairs=1, Columns=2, Garage Doors=1, Int Doors=27
SANIBEL: Ext Doors=4, Windows=23, Baths=4, Stairs=1, Columns=12, Garage Doors=1, Int Doors=27
VERO: Ext Doors=2, Windows=24, Baths=3, Stairs=1, Columns=3, Garage Doors=1, Int Doors=21
BONAIRE: Ext Doors=4, Windows=22, Baths=3.5, Stairs=1, Columns=7, Garage Doors=1, Int Doors=26
SULLIVAN: Ext Doors=2, Windows=10, Baths=3, Stairs=0, Columns=3, Garage Doors=0, Int Doors=15
CAROLINE: Ext Doors=3, Windows=27 (14 floor1+13 floor2), Baths=3.5, Stairs=1, Columns=2, Garage Doors=1, Int Doors=28 (9 floor1+19 floor2)  ← large house

SCALE REMINDER: Large homes regularly have 20–35 windows and 25–35 interior doors across 2 floors. If your window count is under 15 or door count under 20 for a large 2-story house, you are very likely missing rooms. Count EVERY room on EVERY floor before finalizing.`;

// ── Symbol reference images ───────────────────────────────────────────────────
// Loaded once and prepended to every analysis so GPT-4o sees what each symbol
// looks like in this plan style before analyzing a new plan

let _symbolCache = null;

async function loadSymbolReferences() {
  if (_symbolCache !== null) return _symbolCache;
  const FILES = [
    { file: "double_door_symbol_examples.png", caption: "DOUBLE DOOR SYMBOLS: Two arcs at one opening = 2 doors. Hand-drawn versions may look like a Z or mirrored arcs — still 2 doors." },
    { file: "bonaire_7_columns_annotated.png", caption: "COLUMN SYMBOL EXAMPLE — 7 IN THIS PLAN: Red boxes show 7 column squares in this specific plan. YOUR plan may have more or fewer. Count only the squares you can see — do not assume 7." },
    { file: "bonaire_floor1_15_windows_annotated.png", caption: "BONAIRE FIRST FLOOR WINDOWS — 15 TOTAL: Red boxes show all 15 window locations. Do not stop at 12 — trace every exterior wall section." },
    { file: "bonaire_floor2_7_windows_annotated.png", caption: "BONAIRE SECOND FLOOR WINDOWS — 7 TOTAL: Only 7 windows on floor 2 vs 15 on floor 1. Floor 2 always has fewer. If you count 12+ on floor 2, you are overcounting." },
    { file: "bonaire_4_ext_doors_annotated.png", caption: "BONAIRE EXTERIOR DOORS — 4 TOTAL: 2 arcs at front entry porch + 2 arcs at rear covered porch. Count each arc individually." },
    { file: "sullivan_10_windows_annotated.png", caption: "CAD PLAN WINDOWS — 10: Red boxes mark 10 window size codes (3060, 3040, 2040, etc.) on exterior walls. Each code = 1 window. Do NOT count door codes or dimension lines as windows." },
    { file: "sullivan_2_exterior_doors_annotated.png", caption: "CAD EXTERIOR DOORS — 2: Red boxes mark 2 exterior door arcs on perimeter walls. Same quarter-circle arc as interior doors but on outer wall adjacent to porch/outside." },
    { file: "sullivan_15_interior_doors_annotated.png", caption: "CAD PLAN INTERIOR DOORS — 15: Red boxes mark 15 door arcs. Count every arc including closets, WIC, WC, shower — each sub-space has its own arc." },
  ];

  const msgs = [];
  for (const f of FILES) {
    try {
      const url  = chrome.runtime.getURL('training/symbols/' + f.file);
      const res  = await fetch(url);
      const blob = await res.blob();
      const b64  = await new Promise(function(resolve) {
        const reader = new FileReader();
        reader.onload = function(e) { resolve(e.target.result.split(',')[1]); };
        reader.readAsDataURL(blob);
      });
      msgs.push({ type: 'text',      text: f.caption });
      msgs.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64, detail: 'low' } });
    } catch (e) {
      console.warn('[Keel] Could not load symbol image:', f.file, e.message);
    }
  }
  _symbolCache = msgs;
  return msgs;
}

let _fewShotCache = null;

async function getFewShot() {
  if (_fewShotCache !== null) return _fewShotCache;
  _fewShotCache = await buildFewShotMessages();
  return _fewShotCache;
}

async function runOnce(imagesBase64, openaiKey) {
  const [fewShot, symbolRefs] = await Promise.all([getFewShot(), loadSymbolReferences()]);



  // Symbol reference images + plan images in one user message
  const symbolHeader = [{ type: 'text', text: 'SYMBOL REFERENCE: Study these annotated examples to learn what each symbol looks like in this plan style. Red boxes mark the correct symbols. The same symbols appear in any orientation — rotated, flipped, or hand-drawn.' }];
  const planInstruction = [{ type: 'text', text: '⚠ CRITICAL: The floor plan images below are a NEW plan you have never seen. The example plans shown earlier in this conversation (Kiawah, Bonaire, etc.) are TRAINING EXAMPLES ONLY — do NOT copy their counts. Every plan is different. You must count from scratch by looking at the images below.\n\nAnalyze THIS floor plan only. Count what you can see in these images.\n\nIMPORTANT: Many residential plans are single-story with NO interior staircases and NO garage. It is completely normal to count 0 for both. Do not assume they exist.\n\nIF THIS IS A CAD PLAN (clean lines with size codes):\n\nWINDOWS: Look for window size codes (3060, 3040, 2040, 3030, 2640, etc.) next to wall openings on the perimeter. Count each code = 1 window. Trace top, right, bottom, left walls.\n\nINTERIOR DOORS: Look for door size codes (2868, 3068, 2668, 2468, 2068, 1668, etc.) inside door arc swings. Count each = 1 door.\n\nEXTERIOR DOORS: Look for code 3080 on outer perimeter walls.\n\nIF THIS IS A HAND-DRAWN PLAN:\nCount arc symbols for doors, wall gap marks for windows.\n\nBATHS: Check every room. PWDR/POWDER = 0.5, BATH/PRIMARY BATH = 1.0.\n\nSTAIRCASES — PROVE IT BEFORE COUNTING:\nBefore writing any number > 0, answer: Where exactly is the staircase? What room is it in? Is it at least 10 feet from every exterior wall? Does it have 10+ step lines? If you cannot answer YES to all of these, write 0.\n\nGARAGE DOORS — PROVE IT BEFORE COUNTING:\nBefore writing any number > 0, answer: What room is labeled GARAGE on this plan? Can you read the letters G-A-R-A-G-E? If you cannot find and read that exact word as a room label, write 0. Do not count a garage door if you cannot confirm the word GARAGE exists on the plan.\n\nWrite full reasoning then JSON.' }];
  const userContent = symbolHeader.concat(symbolRefs).concat(planInstruction).concat(buildImageContent(imagesBase64));
  // Build messages: system + few-shot examples + current plan
  const messages = [
    { role: 'system', content: ANALYSIS_SYSTEM },
    ...fewShot,
    { role: 'user', content: userContent }
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + openaiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 1500, temperature: 0, messages: messages })
  });
  if (!res.ok) {
    const e = await res.json().catch(function(){return{};});
    throw new Error('OpenAI ' + res.status + ': ' + ((e && e.error && e.error.message) || res.statusText));
  }
  const data = await res.json();
  const text = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
  console.log('[Keel GPT]', text.slice(0, 500));
  lastReasoning = text; // store full response for display

  const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const m = clean.match(/\{[^{}]*\x22exterior_doors\x22[^{}]*\}/);
  if (!m) throw new Error('GPT-4o did not return JSON. Response: ' + text.slice(0, 400));
  const raw = JSON.parse(m[0]);
  const KEYS = ['exterior_doors','windows','baths','staircases','porch_columns','garage_doors','interior_doors'];
  const result = {};
  KEYS.forEach(function(k) {
    const v = raw[k];
    result[k] = { count: (v !== null && typeof v === 'object') ? (v.count || 0) : (Number(v) || 0), locations: [] };
  });
  return result;
}
// Majority vote — run 3 times, take the median count for each category
// More expensive (~$0.06) but significantly more reliable
// ── Split-pass focused prompts ────────────────────────────────────────────────

const WINDOWS_PASS_PROMPT = `You are counting WINDOWS ONLY on a residential floor plan. Ignore doors, columns, baths, and everything else.

WINDOW = a gap in an exterior wall with parallel lines inside and NO arc.

CRITICAL — COUNTING GROUPS: Windows very often appear side-by-side in pairs or triples. Count EACH individual opening separately:
- 2 windows side by side = 2 (not 1)
- 3 windows in a row = 3 (not 1)
- A large bank of 4 windows = 4 (not 1)
Each separate parallel-line gap in the wall = 1 window, regardless of how close together they are.

MANDATORY METHOD — complete every step:
1. List the name of EVERY room that has at least one exterior wall. Include: dining, family room, living, office, bedroom, guest bedroom, primary bedroom, mudroom, garage, gym, bath, primary bath, loft, laundry, sauna — any room touching the outside perimeter.
2. For each room, look at ALL of its exterior walls (a corner room has 2 exterior walls). Count every individual window opening on each wall.
3. Do this for EVERY floor shown.
4. Sum all rooms all floors.

Large homes have 20–30+ windows. If your total is under 20 for a large 2-story plan, you missed rooms or undercounted groups — recheck every room.

Return ONLY this JSON on the last line: {"windows": NUMBER}`;

const INT_DOORS_PASS_PROMPT = `You are counting INTERIOR DOORS ONLY on a residential floor plan. Ignore windows, exterior doors, and everything else.

INTERIOR DOOR = a quarter-circle arc on a wall INSIDE the building (not on a wall that leads to a porch or outside).
Count EVERY arc: bedroom doors, closet (CL) doors, WIC doors, laundry doors, WC doors, shower (SHR) doors, linen closet doors, pantry (BP) doors, office doors, storage doors, gym doors, sauna doors — every arc counts.
CASED OPENING = NOT a door, do not count it.

CRITICAL — PRIMARY BATH AND COMPLEX BATH AREAS: A Primary Bath suite is a cluster of sub-rooms, each with its own door arc. Typical count: 1 entry from bedroom + 1 WC door + 1 shower door + 1 or 2 WIC doors + 1 CL door = 5–6 arcs just in that one suite. Count every single arc you can see in that area.

MANDATORY METHOD:
1. List EVERY room on EVERY floor including all sub-spaces (WC, SHR, CL, WIC, BP, storage, sauna, gym, loft, laundry).
2. For each room/sub-space, count every arc entering or exiting it.
3. A door shared between two rooms is counted ONCE total (do not count from both sides).
4. Large 2-story homes typically have 25–35 interior doors. If your count is under 20, you missed rooms or sub-spaces.

Return ONLY this JSON on the last line: {"interior_doors": NUMBER}`;

const OTHERS_PASS_PROMPT = `You are analyzing a residential floor plan for EXTERIOR DOORS, BATHS, STAIRCASES, PORCH COLUMNS, and GARAGE DOORS only.

EXTERIOR DOORS: Door arcs on walls that lead to a porch, covered porch, or directly outside. Each arc = 1 door. A double (french) door = 2 arcs = 2 doors. A single door = 1 arc = 1 door. Check every porch. Do NOT count garage overhead doors.

BATHS: PWDR / POWDER / HALF BATH = 0.5. All other labeled baths = 1.0 each. List each labeled bath room, then sum.

STAIRCASES: Interior staircases only — must be inside the building, have 10+ step lines, labeled UP or DN with a high number. Count 0 if none visible or unsure.

PORCH COLUMNS: Small solid filled black squares at porch areas. Count ONLY the squares you can actually see — do not guess or apply any formula. Some plans have 2, some have 7, some have 12.

GARAGE DOORS: Only count if you can read the word GARAGE on the plan. Count the dashed OHD rectangle inside the garage room.

Return ONLY this JSON on the last line: {"exterior_doors": N, "baths": N, "staircases": N, "porch_columns": N, "garage_doors": N}`;

async function loadSymbolImg(filename) {
  try {
    const url  = chrome.runtime.getURL('training/symbols/' + filename);
    const res  = await fetch(url);
    const blob = await res.blob();
    const b64  = await new Promise(function(resolve) {
      const reader = new FileReader();
      reader.onload = function(e) { resolve(e.target.result.split(',')[1]); };
      reader.readAsDataURL(blob);
    });
    return { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64, detail: 'low' } };
  } catch(e) { return null; }
}

// ── Claude (Anthropic) API call ───────────────────────────────────────────────

function buildClaudeImageContent(imgs) {
  const c = [];
  imgs.forEach(function(img, i) {
    const b64  = (typeof img === 'string') ? img : img.base64;
    const mime = (typeof img === 'string') ? 'image/png' : (img.mime || 'image/png');
    if (imgs.length > 1) c.push({ type: 'text', text: 'Page ' + (i + 1) + ':' });
    c.push({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
  });
  return c;
}

async function callClaudeFocused(claudeKey, sysPrompt, refs, planContent) {
  const refContent = refs.length ? [
    { type: 'text', text: 'REFERENCE EXAMPLES (red boxes show correct symbols in verified plans):' }
  ].concat(refs.map(function(r) {
    const b64  = r.image_url ? r.image_url.url.split(',')[1] : '';
    return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } };
  })) : [];
  const claudePlan = planContent.map(function(c) {
    if (c.type === 'image_url') return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: c.image_url.url.split(',')[1] } };
    return c;
  });
  const userContent = refContent.concat([
    { type: 'text', text: '⚠ This is a NEW floor plan. Count only the element(s) described in the system prompt. Return ONLY the JSON requested.' }
  ]).concat(claudePlan);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': claudeKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 600,
      system: sysPrompt,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(function(){return{};});
    throw new Error('Claude ' + res.status + ': ' + ((e && e.error && e.error.message) || res.statusText));
  }
  const data = await res.json();
  return ((data.content && data.content[0] && data.content[0].text) || '').trim();
}

// ── Gemini (Google) API call ──────────────────────────────────────────────────

function buildGeminiParts(refs, planContent, instructionText) {
  const parts = [];
  if (refs.length) {
    parts.push({ text: 'REFERENCE EXAMPLES (red boxes show correct symbols in verified plans):' });
    refs.forEach(function(r) {
      const b64 = r.image_url ? r.image_url.url.split(',')[1] : '';
      parts.push({ inline_data: { mime_type: 'image/png', data: b64 } });
    });
  }
  parts.push({ text: instructionText });
  planContent.forEach(function(c, i) {
    if (c.type === 'text') { parts.push({ text: c.text }); return; }
    if (c.type === 'image_url') {
      const url = c.image_url.url;
      const comma = url.indexOf(',');
      const mimeMatch = url.match(/data:([^;]+);/);
      const mime = mimeMatch ? mimeMatch[1] : 'image/png';
      parts.push({ inline_data: { mime_type: mime, data: url.slice(comma + 1) } });
    }
  });
  return parts;
}

async function callGeminiFocused(geminiKey, sysPrompt, refs, planContent) {
  const instruction = '⚠ This is a NEW floor plan. Count only the element(s) described below. Return ONLY the JSON requested.\n\n' + sysPrompt;
  const parts = buildGeminiParts(refs, planContent, instruction);
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: parts }] })
  });
  if (!res.ok) {
    const e = await res.json().catch(function(){return{};});
    throw new Error('Gemini ' + res.status + ': ' + ((e && e.error && e.error.message) || res.statusText));
  }
  const data = await res.json();
  return ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || '').trim();
}

// ── Split-pass (shared logic, model-agnostic) ─────────────────────────────────

async function runSplitPass(imagesBase64, openaiKey, model, claudeKey, geminiKey) {
  const planContent = buildImageContent(imagesBase64);

  // Load annotated reference images for each pass (fire in parallel)
  const [
    // windows
    bWin1, bWin2, sWin, cWin1, cWin2,
    // interior doors
    sDoors, cDoors1, cDoors2, primBath,
    // exterior doors
    dblDoor, bExt, sExt, cExt,
    // columns / others
    bCol, sanCol, sCol,
    // stairs
    stairRef, stairHand, stairNeg,
  ] = await Promise.all([
    // windows
    loadSymbolImg('bonaire_floor1_15_windows_annotated.png'),
    loadSymbolImg('bonaire_floor2_7_windows_annotated.png'),
    loadSymbolImg('sullivan_10_windows_annotated.png'),
    loadSymbolImg('caroline_floor1_14_windows_annotated.png'),
    loadSymbolImg('caroline_floor2_13_windows_annotated.png'),
    // interior doors
    loadSymbolImg('sullivan_15_interior_doors_annotated.png'),
    loadSymbolImg('caroline_floor1_9_int_doors_annotated.png'),
    loadSymbolImg('caroline_floor2_19_int_doors_annotated.png'),
    loadSymbolImg('primary_bath_5_doors_annotated.png'),
    // exterior doors
    loadSymbolImg('double_door_symbol_examples.png'),
    loadSymbolImg('bonaire_4_ext_doors_annotated.png'),
    loadSymbolImg('sullivan_2_exterior_doors_annotated.png'),
    loadSymbolImg('caroline_3_ext_doors_annotated.png'),
    // columns
    loadSymbolImg('bonaire_7_columns_annotated.png'),
    loadSymbolImg('sanibel_12_porch_columns_annotated.png'),
    loadSymbolImg('sullivan_3_columns_annotated.png'),
    // stairs
    loadSymbolImg('interior_stairs_reference.png'),
    loadSymbolImg('interior_stairs_handdrawn.png'),
    loadSymbolImg('sullivan_plan_0_stairs_0_garage.jpg'),
  ]);

  const windowRefs  = [bWin1, bWin2, sWin, cWin1, cWin2].filter(Boolean);
  const doorRefs    = [sDoors, cDoors1, cDoors2, primBath].filter(Boolean);
  const extDoorRefs = [dblDoor, bExt, sExt, cExt].filter(Boolean);
  const othersRefs  = [bCol, sanCol, sCol, stairRef, stairHand, stairNeg].filter(Boolean);

  async function callFocused(sysPrompt, refs) {
    if (model === 'claude') return callClaudeFocused(claudeKey, sysPrompt, refs, planContent);
    if (model === 'gemini') return callGeminiFocused(geminiKey, sysPrompt, refs, planContent);
    // default: gpt4o
    const refContent = refs.length ? [
      { type: 'text', text: 'REFERENCE EXAMPLES (red boxes show correct symbols in verified plans):' }
    ].concat(refs) : [];
    const userContent = refContent.concat([
      { type: 'text', text: '⚠ This is a NEW floor plan. Count only the element(s) described in the system prompt. Return ONLY the JSON requested.' }
    ]).concat(planContent);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + openaiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens: 600, temperature: 0,
        messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userContent }] })
    });
    if (!res.ok) {
      const e = await res.json().catch(function(){return{};});
      throw new Error('OpenAI ' + res.status + ': ' + ((e && e.error && e.error.message) || res.statusText));
    }
    const data = await res.json();
    return (data.choices[0].message.content || '').trim();
  }

  function parseJSON(text) {
    const clean = text.replace(/```(?:json)?/gi, '').replace(/```/g, '');
    const m = clean.match(/\{[^{}]+\}/);
    if (!m) return {};
    try { return JSON.parse(m[0]); } catch(e) { return {}; }
  }

  const [winText, doorsText, othersText] = await Promise.all([
    callFocused(WINDOWS_PASS_PROMPT, windowRefs),
    callFocused(INT_DOORS_PASS_PROMPT, doorRefs),
    callFocused(OTHERS_PASS_PROMPT, extDoorRefs.concat(othersRefs)),
  ]);

  console.log('[Keel windows pass]', winText.slice(0, 200));
  console.log('[Keel doors pass]', doorsText.slice(0, 200));
  console.log('[Keel others pass]', othersText.slice(0, 200));
  lastReasoning = 'WINDOWS PASS:\n' + winText + '\n\nINTERIOR DOORS PASS:\n' + doorsText + '\n\nOTHERS PASS:\n' + othersText;

  const win    = parseJSON(winText);
  const doors  = parseJSON(doorsText);
  const others = parseJSON(othersText);

  const merged = {
    exterior_doors: others.exterior_doors || 0,
    windows:        win.windows           || 0,
    baths:          others.baths          || 0,
    staircases:     others.staircases     || 0,
    porch_columns:  others.porch_columns  || 0,
    garage_doors:   others.garage_doors   || 0,
    interior_doors: doors.interior_doors  || 0,
  };

  // Wrap in the {count, locations:[]} shape the rest of the code expects
  const KEYS = ['exterior_doors','windows','baths','staircases','porch_columns','garage_doors','interior_doors'];
  const out = {};
  KEYS.forEach(function(k) { out[k] = { count: merged[k], locations: [] }; });
  return out;
}

async function callGPT4oFromPanel(imagesBase64, openaiKey, useVoting, model, claudeKey, geminiKey) {
  model = model || 'gpt4o';
  if (!useVoting) return runSplitPass(imagesBase64, openaiKey, model, claudeKey, geminiKey);

  const RUNS = 3;
  const results = [];
  for (let i = 0; i < RUNS; i++) {
    try { results.push(await runSplitPass(imagesBase64, openaiKey, model, claudeKey, geminiKey)); }
    catch (e) { console.warn('[Keel vote ' + i + ' failed]', e.message); }
  }
  if (!results.length) throw new Error('All analysis attempts failed.');

  const keys = ['exterior_doors','windows','baths','staircases','porch_columns','garage_doors','interior_doors'];
  const consensus = {};
  keys.forEach(function(k) {
    const counts = results.map(function(r) { return (r[k] && r[k].count) || 0; }).sort(function(a,b){return a-b;});
    const median = counts[Math.floor(counts.length / 2)];
    const bestRun = results.find(function(r) { return r[k] && r[k].count === median; }) || results[0];
    consensus[k] = { count: median, locations: (bestRun[k] && bestRun[k].locations) || [] };
  });
  console.log('[Keel consensus]', JSON.stringify(consensus).slice(0, 200));
  return consensus;
}

// ── Auto-crop whitespace ──────────────────────────────────────────────────────

function autoCropToFloorPlan(base64) {
  return new Promise(function(resolve) {
    const img = new Image();
    img.onload = function() {
      const W = img.width, H = img.height;
      const tmp = document.createElement('canvas');
      tmp.width = W; tmp.height = H;
      const ctx = tmp.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, W, H).data;
      let minX = W, minY = H, maxX = 0, maxY = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (data[i] < 238 || data[i+1] < 238 || data[i+2] < 238) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX <= minX || maxY <= minY) { resolve({ base64: base64 }); return; }
      const pad = 40;
      minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
      maxX = Math.min(W, maxX + pad);  maxY = Math.min(H, maxY + pad);
      const cW = maxX - minX, cH = maxY - minY;
      const out = document.createElement('canvas');
      out.width = cW; out.height = cH;
      out.getContext('2d').drawImage(tmp, minX, minY, cW, cH, 0, 0, cW, cH);
      resolve({ base64: out.toDataURL('image/png').split(',')[1] });
    };
    img.onerror = function() { resolve({ base64: base64 }); };
    img.src = 'data:image/png;base64,' + base64;
  });
}

// ── PDF rendering (uses pdfjsLib from pdfjs-init.js) ─────────────────────────

function waitForPDFjs() {
  if (window.pdfjsReady && window.pdfjsLib) return Promise.resolve();
  return new Promise(function(resolve, reject) {
    const t = setTimeout(function() { reject(new Error('PDF engine not ready. Try uploading a PNG/JPG instead.')); }, 5000);
    document.addEventListener('pdfjs-ready', function() { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Parse page range string → array of 1-based page numbers
// "2-4" → [2,3,4]   "2,3" → [2,3]   "3" → [3]   "" → null (all pages)
function parsePageRange(str, totalPages) {
  if (!str || !str.trim()) return null; // null = all pages
  const nums = new Set();
  str.split(',').forEach(function(part) {
    part = part.trim();
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= Math.min(b, totalPages); i++) nums.add(i);
    } else if (!isNaN(parseInt(part))) {
      const n = parseInt(part);
      if (n >= 1 && n <= totalPages) nums.add(n);
    }
  });
  return nums.size > 0 ? Array.from(nums).sort(function(a,b){return a-b;}) : null;
}

// Auto-detect floor plan pages by looking for room label keywords
// Returns array of page numbers that look like floor plans
async function detectFloorPlanPages(pdf) {
  const floorPlanPages = [];

  // Must have these drawing indicators to be a floor plan page
  const FLOOR_PLAN_SIGNALS = /\b(floor\s*plan|first\s*floor|second\s*floor|third\s*floor|main\s*level|upper\s*level|a1\.|a2\.|a1\.1|a1\.2|sheet\s*a)/i;

  // Disqualify pages that look like spec/cover/detail sheets
  const SPEC_SHEET_SIGNALS = /\b(included\s*features|specifications|copyright\s*notice|general\s*notes|drawing\s*index|cover\s*sheet|elevation|section|electrical|plumbing|mechanical|detail|schedule|legend|symbol|not\s*for\s*construction.*cover)\b/i;

  for (let p = 1; p <= pdf.numPages; p++) {
    try {
      const page    = await pdf.getPage(p);
      const content = await page.getTextContent();
      const text    = content.items.map(function(i) { return i.str; }).join(' ');

      const isFloorPlan = FLOOR_PLAN_SIGNALS.test(text);
      const isSpecSheet = SPEC_SHEET_SIGNALS.test(text);

      // Page must look like a floor plan AND not look like a spec/cover sheet
      if (isFloorPlan && !isSpecSheet) floorPlanPages.push(p);
    } catch (_) {}
  }

  // Fallback: if nothing detected, use all pages (capped at 6)
  if (floorPlanPages.length === 0) {
    const total = Math.min(pdf.numPages, 6);
    for (let i = 1; i <= total; i++) floorPlanPages.push(i);
  }
  return floorPlanPages;
}

async function renderPDFInPanel(base64String, pageRangeStr) {
  await waitForPDFjs();
  const binary = atob(base64String);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;

  // Determine which pages to render
  let pagesToRender;
  const rangeFromInput = parsePageRange(pageRangeStr, pdf.numPages);
  if (rangeFromInput) {
    pagesToRender = rangeFromInput;
    setProgress(15, 'Rendering pages ' + pageRangeStr + '…');
  } else {
    setProgress(12, 'Detecting floor plan pages…');
    pagesToRender = await detectFloorPlanPages(pdf);
    setProgress(18, 'Found floor plan pages: ' + pagesToRender.join(', '));
  }

  const pages = [];
  for (let idx = 0; idx < pagesToRender.length; idx++) {
    const p        = pagesToRender[idx];
    const page     = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 2.5 });
    const canvas   = document.createElement('canvas');
    canvas.width   = Math.round(viewport.width);
    canvas.height  = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    pages.push(canvas.toDataURL('image/png').split(',')[1]);
    canvas.remove();
    setProgress(18 + Math.round((idx + 1) / pagesToRender.length * 40), 'Rendered page ' + p + ' of ' + pdf.numPages);
  }
  return pages;
}

// ── Upload Plans ──────────────────────────────────────────────────────────────

let uploadedFiles = [];

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function readFileAsBase64(file) {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader();
    reader.onload  = function(e) { resolve(e.target.result.split(',')[1]); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function openUploadedFile(f) {
  try {
    var mime  = f.mimeType || (f.isPDF ? 'application/pdf' : 'image/png');
    var bytes = atob(f.base64);
    var arr   = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    var blob  = new Blob([arr], { type: mime });
    var url   = URL.createObjectURL(blob);
    chrome.tabs.create({ url: url });
  } catch (e) { showStatus('Could not open file: ' + e.message, 'error', 3000); }
}

function renderUploadList() {
  var list = $('upload-file-list');
  list.innerHTML = '';
  uploadedFiles.forEach(function(f, i) {
    var item = document.createElement('div');
    item.className = 'upload-file-item';
    var nameSpan = document.createElement('span');
    nameSpan.className = 'fname';
    nameSpan.title = 'Click to open ' + f.name;
    nameSpan.textContent = f.name;
    nameSpan.style.cssText = 'cursor:pointer;text-decoration:underline;color:#2b6cb0';
    nameSpan.dataset.idx = i;
    var metaSpan = document.createElement('span');
    metaSpan.className = 'fmeta';
    metaSpan.textContent = formatBytes(f.size) + (f.isPDF ? ' · PDF' : '');
    var removeSpan = document.createElement('span');
    removeSpan.className = 'fremove';
    removeSpan.title = 'Remove';
    removeSpan.textContent = '✕';
    removeSpan.dataset.idx = i;
    item.appendChild(nameSpan);
    item.appendChild(metaSpan);
    item.appendChild(removeSpan);
    list.appendChild(item);
  });
  list.querySelectorAll('.fname').forEach(function(el) {
    el.addEventListener('click', function(e) {
      openUploadedFile(uploadedFiles[parseInt(e.target.dataset.idx)]);
    });
  });
  list.querySelectorAll('.fremove').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      uploadedFiles.splice(parseInt(e.target.dataset.idx), 1);
      if (uploadedFiles.length === 0) $('upload-info').classList.add('hidden');
      else renderUploadList();
    });
  });
  $('upload-info').classList.remove('hidden');
}

async function handleFiles(fileList) {
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (!allowed.includes(file.type) && !file.name.endsWith('.pdf')) continue;
    const base64 = await readFileAsBase64(file);
    const isPDF  = file.type === 'application/pdf' || file.name.endsWith('.pdf');
    uploadedFiles.push({ name: file.name, size: file.size, base64: base64, mimeType: file.type, isPDF: isPDF });
  }
  if (uploadedFiles.length > 0) renderUploadList();
}

function setProgress(pct, label) {
  $('progress-bar').style.width = pct + '%';
  $('progress-label').textContent = label;
  if (pct > 0) $('upload-progress').classList.remove('hidden');
}

// ── PDF.js ready indicator ────────────────────────────────────────────────────

function initPDFjsIndicator() {
  const bar   = $('pdfjs-bar');
  const label = $('pdfjs-label');
  if (!bar || !label) return;

  if (window.pdfjsReady) {
    bar.classList.add('ready');
    label.classList.add('ready');
    label.textContent = '✓ PDF Engine Ready';
    return;
  }

  bar.classList.add('loading');
  label.textContent = 'Loading PDF engine…';

  const poll = setInterval(function() {
    if (window.pdfjsReady) {
      clearInterval(poll);
      bar.classList.remove('loading');
      bar.classList.add('ready');
      label.classList.add('ready');
      label.textContent = '✓ PDF Engine Ready';
      const btn = $('btn-analyze-upload');
      if (btn) btn.disabled = false;
    }
  }, 150);

  setTimeout(function() {
    if (!window.pdfjsReady) {
      clearInterval(poll);
      bar.style.background = '#fc8181';
      bar.classList.remove('loading');
      bar.style.width = '100%';
      label.textContent = 'PDF unavailable — upload PNG/JPG instead';
      label.style.color = '#e53e3e';
      const btn = $('btn-analyze-upload');
      if (btn) btn.disabled = false;
    }
  }, 4000);
}

function initUploadPanel() {
  const analyzeBtn = $('btn-analyze-upload');
  if (analyzeBtn && !window.pdfjsReady) analyzeBtn.disabled = true;
  initPDFjsIndicator();

  const dropZone  = $('drop-zone');
  const fileInput = $('file-input');
  if (!dropZone || !fileInput) return;

  dropZone.addEventListener('dragover',  function(e) { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', function()  { dropZone.classList.remove('drag-over'); });
  dropZone.addEventListener('drop', function(e) {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', function() { handleFiles(fileInput.files); fileInput.value = ''; });
  $('btn-browse').addEventListener('click', function(e) { e.stopPropagation(); fileInput.click(); });
  $('btn-analyze-upload').addEventListener('click', analyzeUploads);
  $('btn-clear-upload').addEventListener('click', function() {
    uploadedFiles = [];
    $('upload-info').classList.add('hidden');
    $('upload-progress').classList.add('hidden');
    $('progress-bar').style.width = '0%';
  });
}

async function analyzeUploads() {
  if (!uploadedFiles.length) { showStatus('Add a file first', 'error', 3000); return; }
  const cfg = await new Promise(function(r) { chrome.storage.local.get(['openaiKey','claudeKey','geminiKey'], r); });

  const modelSel = $('ai-model-select');
  const model = modelSel ? modelSel.value : 'gpt4o';
  const modelNames = { gpt4o: 'GPT-4o', claude: 'Claude 3.5 Sonnet', gemini: 'Gemini 2.0 Flash' };
  const modelLabel = modelNames[model] || 'GPT-4o';

  if (model === 'gpt4o' && !cfg.openaiKey) { showStatus('Add your OpenAI API key in ⚙ Settings first', 'error', 5000); return; }
  if (model === 'claude' && !cfg.claudeKey) { showStatus('Add your Anthropic (Claude) API key in ⚙ Settings first', 'error', 5000); return; }
  if (model === 'gemini' && !cfg.geminiKey) { showStatus('Add your Google Gemini API key in ⚙ Settings first', 'error', 5000); return; }

  const btn = $('btn-analyze-upload');
  btn.disabled = true; btn.textContent = 'Analyzing…';
  $('ai-results').classList.add('hidden');
  $('ai-loading').classList.remove('hidden');
  setProgress(5, 'Preparing files…');

  try {
    const allImages = []; // array of {base64, mime}
    for (let fi = 0; fi < uploadedFiles.length; fi++) {
      const f   = uploadedFiles[fi];
      const pct = Math.round((fi / uploadedFiles.length) * 55) + 5;
      setProgress(pct, 'Processing ' + f.name + '…');
      if (f.isPDF) {
        const pageRangeStr = ($('page-range-input') && $('page-range-input').value.trim()) || '';
        const pages = await renderPDFInPanel(f.base64, pageRangeStr);
        setProgress(pct + 10, f.name + ': ' + pages.length + ' floor plan page(s) ready');
        pages.forEach(function(p) { allImages.push({ base64: p, mime: 'image/png' }); });
      } else {
        // Use the actual file MIME type — critical for JPEG files
        const mime = f.mimeType || 'image/png';
        allImages.push({ base64: f.base64, mime: mime });
      }
    }
    if (!allImages.length) throw new Error('No pages could be extracted.');

    const MAX_PAGES   = 6;
    const pagesToSend = allImages.slice(0, MAX_PAGES);
    if (allImages.length > MAX_PAGES) showStatus('Large PDF: using first ' + MAX_PAGES + ' of ' + allImages.length + ' pages', 'info', 4000);

    const useVoting = $('chk-vote') && $('chk-vote').checked;
    setProgress(70, useVoting ? 'Running 3× majority vote…' : 'Sending to ' + modelLabel + '…');
    showStatus(modelLabel + ' analyzing plan…', 'info', 0);
    const result = await callGPT4oFromPanel(pagesToSend, cfg.openaiKey, useVoting, model, cfg.claudeKey, cfg.geminiKey);

    setProgress(100, 'Done!');
    lastAiResult    = result;
    lastImageBase64 = pagesToSend[0].base64 || pagesToSend[0];
    lastImageMime   = pagesToSend[0].mime   || 'image/png';

    displayAiResults(result, modelLabel + ' · ' + pagesToSend.length + ' page' + (pagesToSend.length > 1 ? 's' : ''));
    showStatus('✓ Done — ' + pagesToSend.length + ' page(s) analyzed', 'success');

  } catch (e) {
    showStatus('Error: ' + e.message, 'error', 10000);
  } finally {
    btn.disabled = false; btn.textContent = 'Analyze Plan';
    $('ai-loading').classList.add('hidden');
    setTimeout(function() { $('upload-progress').classList.add('hidden'); }, 2500);
  }
}

// ── AI Plan Analysis (from BuilderTrend tab) ──────────────────────────────────

async function runAiAnalysis() {
  $('ai-loading').classList.remove('hidden');
  $('ai-results').classList.add('hidden');
  $('btn-analyze').disabled = true;

  try {
    showStatus('Fetching PDF from BuilderTrend…', 'info', 0);
    try {
      const pdfRes = await sendMsg('ANALYZE_PDF');
      lastAiResult    = pdfRes.result;
      lastImageBase64 = null;
      lastImageMime   = 'image/png';
      displayAiResults(pdfRes.result, 'Full PDF · ' + (pdfRes.pages || 1) + ' page(s)');
      showStatus('✓ Analyzed full PDF at full resolution', 'success');
      return;
    } catch (pdfErr) {
      showStatus('PDF grab failed — falling back to screenshot…', 'info', 0);
    }

    showStatus('Capturing plan screenshot…', 'info', 0);
    const imageData = await sendMsg('CAPTURE_TAB_SCREENSHOT');
    if (!imageData || !imageData.base64) throw new Error('Could not capture plan. Make sure the BuilderTrend takeoff page is open.');

    lastImageBase64 = imageData.base64;
    lastImageMime   = imageData.mimeType || 'image/png';
    showStatus('Sending to GPT-4o…', 'info', 0);
    const res = await sendMsg('ANALYZE_PLAN', { imageBase64: lastImageBase64, mimeType: lastImageMime });
    lastAiResult = res.result;
    displayAiResults(res.result, 'Screenshot');
    showStatus('✓ Analysis complete', 'success');

  } catch (e) {
    showStatus('Error: ' + e.message, 'error', 8000);
  } finally {
    $('ai-loading').classList.add('hidden');
    $('btn-analyze').disabled = false;
  }
}

function displayAiResults(result, badge) {
  if (badge) { var b = $('ai-confidence'); if (b) b.textContent = badge; }
  var grid = $('ai-grid');
  grid.innerHTML = "";

  // Store corrected counts (start equal to AI counts, user can adjust)
  if (!lastAiResult) lastAiResult = result;

  Object.keys(AI_LABELS).forEach(function(key) {
    var rawCount = result[key] ? result[key].count : 0;
    var isHalf   = (rawCount % 1 !== 0); // e.g. baths = 3.5
    var count    = typeof rawCount === 'number' ? rawCount : 0;

    var item = document.createElement('div');
    item.className = 'ai-item';

    if (isHalf) {
      // Non-integer (baths): show static value, no stepper
      item.innerHTML =
        '<span class="ai-item-label">' + AI_LABELS[key] + '</span>' +
        '<span class="ai-adj-val">' + count + '</span>';
    } else {
      item.innerHTML =
        '<span class="ai-item-label">' + AI_LABELS[key] + '</span>' +
        '<div class="ai-item-adj">' +
          '<button class="ai-adj-btn" data-key="' + key + '" data-delta="-1">−</button>' +
          '<span class="ai-adj-val" data-key="' + key + '">' + count + '</span>' +
          '<button class="ai-adj-btn" data-key="' + key + '" data-delta="1">+</button>' +
        '</div>';
    }
    grid.appendChild(item);
  });

  // +/− button handlers
  grid.querySelectorAll('.ai-adj-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var key   = btn.dataset.key;
      var delta = parseInt(btn.dataset.delta);
      var val   = lastAiResult[key] ? (lastAiResult[key].count || 0) : 0;
      val = Math.max(0, val + delta);
      lastAiResult[key] = { count: val, locations: [] };
      var span = grid.querySelector('.ai-adj-val[data-key="' + key + '"]');
      if (span) span.textContent = val;
      // Keep manual inputs and grab grid in sync
      var mapKey = AI_KEY_MAP[key];
      if (mapKey) {
        var input = document.querySelector('.manual-row input[data-key="' + mapKey + '"]');
        if (input) input.value = val;
      }
      mergeAiIntoGrab(lastAiResult);
    });
  });

  $('ai-results').classList.remove('hidden');
  // Reasoning toggle
  var rBox = $('ai-reasoning');
  var rBtn = $('btn-show-reasoning');
  if (rBox && rBtn) {
    rBox.classList.add('hidden');
    rBtn.textContent = 'Show Reasoning ▾';
    if (lastReasoning) {
      var stripped = lastReasoning.replace(/\{[\s\S]*\}[\s]*$/, "").trim();
      rBox.textContent = stripped.length > 10 ? stripped : "GPT skipped reasoning — counts only returned.";
      rBtn.style.display = "";
    } else {
      rBtn.style.display = "none";
    }
  }
  // Pre-fill manual inputs
  Object.keys(AI_KEY_MAP).forEach(function(key) {
    var count = result[key] && result[key].count;
    if (count !== undefined) {
      var input = document.querySelector('.manual-row input[data-key="' + AI_KEY_MAP[key] + '"]');
      if (input) input.value = count;
    }
  });

  // Merge AI counts into the grab section if it is visible
  mergeAiIntoGrab(result);
}

function mergeAiIntoGrab(result) {
  var grabResults = $('grab-results');
  if (!grabResults || grabResults.classList.contains('hidden')) return;
  var grid = $('grab-grid');
  if (!grid) return;
  // Update grab grid items whose keys match AI results
  Object.keys(AI_KEY_MAP).forEach(function(aiKey) {
    var grabKey = AI_KEY_MAP[aiKey];
    var count = result[aiKey] && result[aiKey].count;
    if (count === undefined || count === null) return;
    // Find the grab item for this key by label text
    var grabLabel = GRAB_LABELS[grabKey];
    if (!grabLabel) return;
    var items = grid.querySelectorAll('.grab-item');
    items.forEach(function(item) {
      var lbl = item.querySelector('.g-label');
      if (lbl && lbl.textContent === grabLabel) {
        var valEl = item.querySelector('.g-val');
        if (valEl) {
          valEl.textContent = count;
          item.classList.toggle('zero', count === 0);
          // also update grabbedData so Write All to Sheet sends correct value
          if (typeof grabbedData !== 'undefined') grabbedData[grabKey] = count;
        }
      }
    });
  });
  $('grab-status').textContent = 'AI counts merged in — press Write All to Sheet to save';
}

async function writeAiToSheet() {
  if (!lastAiResult) return;
  const values = {};
  for (const key in AI_KEY_MAP) {
    const count = lastAiResult[key] && lastAiResult[key].count;
    if (count !== undefined && count !== null) values[AI_KEY_MAP[key]] = count;
  }
  showStatus('Writing AI counts to database…', 'info', 0);
  try {
    const res = await sendMsg('WRITE_VALUES', { values: values });
    showStatus('✓ Wrote ' + res.written + ' values to database', 'success');
    setTimeout(function() { loadSheetTab(activeTab); }, 1200);
  } catch (e) {
    showStatus('Write error: ' + e.message, 'error', 6000);
  }
}

// ── Grab Takeoff ──────────────────────────────────────────────────────────────

const GRAB_LABELS = {
  // Areas (from takeoff)
  'basement':                 'Basement',
  '1st floor':                '1st Floor',
  '2nd floor':                '2nd Floor',
  '3rd floor':                '3rd Floor',
  'attic with storage':       'Attic w/ Storage',
  'habitable attic':          'Habitable Attic',
  'front porch':              'Front Porch',
  'rear porch':               'Rear Porch',
  'rear deck':                'Rear Deck',
  'garage':                   'Garage',
  'cabinets lf':              'Cabinets LF',
  'countertops lf':           'Countertops LF',
  // Counts (from AI analysis + takeoff)
  '# of exterior doors':      '# Exterior Doors',
  '# of interior doors':      '# Interior Doors',
  '# of windows':             '# Windows',
  '# of baths':               '# Baths',
  '# of staircases':          '# Staircases',
  '# of front porch columns': '# Porch Columns',
  '# of garage doors':        '# Garage Doors',
  // Flooring
  'sf of carpet':             'SF Carpet',
  'sf of hardwood':           'SF Hardwood',
  'sf of tile':               'SF Tile',
};

let grabbedData = {};

async function grabTakeoff() {
  const btn = $('btn-write-grab');
  btn.disabled = true; btn.textContent = 'Scanning…';
  try {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(function(t) { return t.url && t.url.includes('squaretakeoff'); })
             || tabs.find(function(t) { return t.url && t.url.includes('buildertrend'); })
             || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab) throw new Error('No SquareTakeoff or BuilderTrend tab found.');

    try {
      const probe = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () { return !!window.__keelListenerRegistered; }
      });
      if (!probe[0]?.result) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      }
    } catch (_) {
      try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch (_2) {}
    }

    const res = await new Promise(function (resolve, reject) {
      chrome.tabs.sendMessage(tab.id, { action: 'GRAB_TAKEOFF' }, { frameId: 0 }, function (r) {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!r) { reject(new Error('No response from content script')); return; }
        resolve(r);
      });
    });
    if (!res.ok) throw new Error(res.error || 'Scrape failed');

    grabbedData = res.data;
    const found = res.found || 0;
    showStatus('✓ Grabbed ' + found + ' takeoff value(s)', 'success');
  } catch (e) {
    showStatus('Grab failed: ' + e.message, 'error', 8000);
  } finally {
    btn.disabled = false; btn.textContent = 'Grab & Write to Sheet';
  }
}

// ── Write to Estimate ─────────────────────────────────────────────────────────
// Gathers items/site-options/custom-allowances from this panel's own DOM,
// then hands off to tabpicker.html — the same tab-picker + write flow used
// by the guided-takeoff button, the base-plan flow, and the webpage, so
// there's exactly one write implementation to keep in sync (see tabpicker.js).
// The Stop control for an in-progress write now lives in tabpicker.html.

async function writeToEstimate() {
  const btn = $('btn-write-estimate');
  const logEl = $('estimate-log');
  btn.disabled = true; btn.textContent = 'Working…';
  logEl.textContent = ''; logEl.classList.remove('hidden');
  const lender = $('chk-lender') && $('chk-lender').checked;
  const slowConnection = !!($('chk-slow-connection') && $('chk-slow-connection').checked);

  function log(msg) {
    logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  try {
    log('Reading sheet values…');
    // The 6 "TOTAL FOR..." subtotal labels have no cost_items row of their
    // own, and it turns out the Sheet's subtotal rows never carry a
    // quantity at all — only their own $0.00 Amount column is populated
    // (verified live). Every one of these now comes from Supabase's
    // quantity_formula instead — no D-cell reads needed anywhere in this
    // function anymore.
    const cells = await sendMsg('READ_CELLS_BATCH', {
      ranges: ['I13','I4','I5','I6','I9','I10','I11','I12','I18','I19','I20',
               'I21','I22','I23','I24','I25','I26','I27','I28','I29']
    });
    const c = cells.data;
    const n = function(v) { return parseFloat(String(v || '0').replace(/[^0-9.-]/g, '')) || 0; };

    const items = [
      { name: 'Total Fixed Cost',                                                    qty: 1 },
      { name: 'Total Finished SF & Unfinished (Under Roof)',                         qty: n(c['I13']) },
      { name: 'Total Finished SF',                                                   qty: 0 }, // resolved below via quantity_formula
      { name: 'Total Finished SF & Unfinished SF (Under Roof Excluding Porches)',     qty: 0 },
      { name: 'Total Garage SF',                                                     qty: 0 },
      { name: 'Total 1st Floor Finished, 1st Floor Unfinished & Garage',            qty: 0 },
      { name: 'Total 1st Floor, Garage & Porch SF',                                 qty: 0 },
      { name: 'Total Finished 1st Floor SF',                                        qty: 0 },
      { name: 'Total for Decks & Porches',                                          qty: n(c['I9']) + n(c['I10']) + n(c['I11']) },
      { name: 'Interior Stairs',    qty: n(c['I23']) },
      { name: 'Exterior Doors',     qty: n(c['I18']) },
      { name: 'Windows',            qty: n(c['I19']) },
      { name: 'Porch Columns',      qty: n(c['I24']) },
      { name: 'Interior Doors',     qty: n(c['I26']) },
      { name: 'Garage Door',        qty: 0 }, // resolved below via quantity_formula (=I25)
      { name: 'Number of Baths',    qty: n(c['I20']) },
      { name: 'Accessories Allowance',       qty: 0 }, // resolved below via quantity_formula
      { name: 'Appliance Allowance',         qty: 1 },
      { name: 'Cabinet Allowance',           qty: 0 },
      { name: 'Carpet Allowance',            qty: 0 },
      { name: 'Countertop Allowance',        qty: 0 },
      { name: 'Hardwood Flooring Allowance', qty: 0 },
      { name: 'Lighting Fixture Allowance',  qty: 0 },
      { name: 'Plumbing Fixture Allowance',  qty: 0 },
      { name: 'Tile Allowance',              qty: 0 },
      { name: 'Clearing Allowance',    qty: 1 },
      { name: 'Driveway Allowance',    qty: 1 },
      { name: 'Landscaping Allowance', qty: 0 },
      { name: 'Tap Fees',              qty: 1 },
    ];

    // Fill in every quantity_formula-driven item (QUANTITY_FROM_FORMULA_ITEMS
    // — the 9 allowances, Garage Door, Landscaping, and the 6 subtotal
    // proxies) from Supabase, evaluated against the I-cells already read
    // above. A lookup miss or a fetch failure leaves that item's qty at
    // the 0 placeholder set above rather than guessing — check the write
    // log for a console warning if that happens.
    try {
      const qtyFormulas = await fetchQuantityFormulasFromSupabase(QUANTITY_FROM_FORMULA_ITEMS);
      items.forEach(function(item) {
        if (QUANTITY_FROM_FORMULA_ITEMS.indexOf(item.name) === -1) return;
        const formula = qtyFormulas[item.name];
        if (formula === undefined) { console.warn('[Keel] no quantity_formula match for', item.name); return; }
        item.qty = evaluateQuantityFormula(formula, c);
      });
    } catch (e) {
      console.warn('[Keel] quantity_formula lookup failed, allowance/garage-door quantities left at 0:', e.message);
    }
    if (lender) items.push({ name: 'Preferred Lender Incentive', qty: 1 });

    // Good/Better/Best allowance tiers — Group A (9 quantity-driven allowances).
    // Radio choices (.ext-tier-select), Good pre-checked by default. Multiplier
    // scales the computed quantity; Better/Best also stamp a description.
    // Multipliers are read fresh every run and never persisted; if the
    // Supabase read fails, this degrades to "everyone is Good" rather than
    // blocking the write — the description note is the only visible sign
    // of a tier upgrade, quantities and the estimate itself always work.
    const ALLOWANCE_TIER_GROUP_A = [
      'Accessories Allowance', 'Appliance Allowance', 'Cabinet Allowance', 'Carpet Allowance',
      'Countertop Allowance', 'Hardwood Flooring Allowance', 'Lighting Fixture Allowance',
      'Plumbing Fixture Allowance', 'Tile Allowance'
    ];
    function tierDescription(tier) {
      if (tier === 'better') return 'Upgrade: Better';
      if (tier === 'best') return 'Upgrade: Best';
      return null;
    }
    let allowanceTierMultipliers = { good: 1, better: 1, best: 1 };
    try {
      const tierResp = await sendMsg('READ_ALLOWANCE_TIER_MULTIPLIERS', {});
      if (tierResp && tierResp.multipliers) allowanceTierMultipliers = tierResp.multipliers;
    } catch (e) {
      console.warn('[Keel] allowance tier multipliers unavailable, defaulting all to Good:', e.message);
    }
    const extTierByItemName = {};
    document.querySelectorAll('.ext-tier-select:checked').forEach(function(el) {
      const itemName = el.getAttribute('data-item');
      if (itemName) extTierByItemName[itemName] = el.value || 'good';
    });
    items.forEach(function(item) {
      if (ALLOWANCE_TIER_GROUP_A.indexOf(item.name) === -1) return;
      const tier = extTierByItemName[item.name] || 'good';
      const multiplier = allowanceTierMultipliers[tier];
      if (multiplier && multiplier !== 1) item.qty = item.qty * multiplier;
      const desc = tierDescription(tier);
      if (desc) item.description = desc;
    });

    // Unit costs from the Supabase admin price list — every item gets one
    // now, not just the allowances. This panel has no "base plan" concept,
    // so it always uses the Custom-Plan-style average (every house_rates
    // row flagged include_in_average), never a single house's own rate.
    // Anon-key read, same pattern as READ_ALLOWANCE_TIER_MULTIPLIERS — no
    // sign-in needed. A cost_items lookup miss for an item just leaves
    // that item's unitCost unset, which tabpicker.js treats as "don't
    // touch BuilderTrend's existing rate" rather than writing a guess.
    try {
      const unitCosts = await fetchUnitCostsFromSupabase(items.map(function(it) { return it.name; }), null);
      let setCount = 0;
      items.forEach(function(item) {
        const uc = unitCosts[item.name];
        if (uc !== null && uc !== undefined) { item.unitCost = uc; setCount++; }
      });
      console.log('[Keel][unitcost] popup.js writeToEstimate(): set unitCost on ' + setCount + ' of ' + items.length + ' item(s)');
    } catch (e) {
      console.error('[Keel][unitcost] popup.js writeToEstimate(): fetch threw, NO items got a unitCost this run. Full error:', e);
    }

    // Read site option dropdowns from extension panel
    const EXT_SITE_MAP = {
      'ext-so-sewer': {
        'City (No Septic)':    { row: 2,  parentGroup: '11 - Septic/Sewer',           title: 'Sewer - City (No Septic)',          existingLine: null },
        'Conventional Septic': { row: 3,  parentGroup: '11 - Septic/Sewer',           title: 'Sewer - Conventional Septic',       existingLine: null },
        'Engineered Septic':   { row: 4,  parentGroup: '11 - Septic/Sewer',           title: 'Sewer - Engineered Septic',         existingLine: null },
      },
      'ext-so-water': {
        'Well':                { row: 6,  parentGroup: 'Well Allowance',               title: 'Water - Well',                      existingLine: null },
      },
      'ext-so-tap': {
        'None (Well/Septic)':  { row: 7,  parentGroup: '06 - Municipal Tap Fees',     title: 'Municipal Tap Fees - None (Well/Septic)', existingLine: 'Tap Fees' },
        'Standard (12K)':      { row: 8,  parentGroup: '06 - Municipal Tap Fees',     title: 'Municipal Tap Fees - Standard',     existingLine: 'Tap Fees' },
        'High (18K)':          { row: 9,  parentGroup: '06 - Municipal Tap Fees',     title: 'Municipal Tap Fees - High',         existingLine: 'Tap Fees' },
      },
      'ext-so-clearing': {
        'Light':               { row: 10, parentGroup: '09 - Lot Clearing/Site Prep', title: 'Lot Clearing - Light',              existingLine: 'Clearing Allowance' },
        'Moderate':            { row: 11, parentGroup: '09 - Lot Clearing/Site Prep', title: 'Lot Clearing - Moderate',           existingLine: 'Clearing Allowance' },
        'Heavy':               { row: 12, parentGroup: '09 - Lot Clearing/Site Prep', title: 'Lot Clearing - Heavy',              existingLine: 'Clearing Allowance' },
      },
      'ext-so-driveway': {
        'Short Gravel':        { row: 13, parentGroup: 'Driveway Allowance',           title: 'Driveway - Short Gravel',           existingLine: 'Driveway Allowance' },
        'Standard (Gravel)':   { row: 14, parentGroup: 'Driveway Allowance',           title: 'Driveway - Standard (Gravel)',      existingLine: 'Driveway Allowance' },
        'Long Gravel':         { row: 15, parentGroup: 'Driveway Allowance',           title: 'Driveway - Long Gravel',            existingLine: 'Driveway Allowance' },
        'Asphalt':             { row: 16, parentGroup: 'Driveway Allowance',           title: 'Driveway - Asphalt',               existingLine: 'Driveway Allowance' },
      },
      'ext-so-landscaping': {
        'Basic':               { row: 17, parentGroup: '62 - Landscaping',             title: 'Landscaping - Basic',               existingLine: 'Landscaping Allowance' },
        'Standard':            { row: 18, parentGroup: '62 - Landscaping',             title: 'Landscaping - Standard',            existingLine: 'Landscaping Allowance' },
        'Extensive':           { row: 19, parentGroup: '62 - Landscaping',             title: 'Landscaping - Extensive',           existingLine: 'Landscaping Allowance' },
      },
    };
    const selectedSiteItems = [];
    Object.keys(EXT_SITE_MAP).forEach(function(id) {
      const el = document.getElementById(id);
      const val = el ? el.value : '';
      const map = EXT_SITE_MAP[id];
      if (val && map && map[val]) {
        const entry = map[val];
        selectedSiteItems.push({ name: entry.title, row: entry.row, parentGroup: entry.parentGroup, existingLine: entry.existingLine || null });
      }
    });

    const siteOptions = [];
    if (selectedSiteItems.length) {
      log('Reading SITE OPTIONS pricing…');
      const soResp = await sendMsg('READ_CELLS_RANGE_TAB', { tab: 'SITE OPTIONS', range: 'C2:C19' });
      const cRows = soResp.data || [];
      selectedSiteItems.forEach(function(item) {
        const rowData = cRows[item.row - 2];
        const unitCost = parseFloat(String((rowData && rowData[0]) || '0').replace(/[^0-9.-]/g, '')) || 0;
        siteOptions.push({ name: item.name, parentGroup: item.parentGroup, unitCost: unitCost, existingLine: item.existingLine });
      });
    }

    // Read + validate custom selection allowances from static Write to
    // Estimate panel — each row needs BOTH a name and a price, or neither
    // (a fully blank row is fine and simply skipped).
    const customItems = [];
    let customRowError = null;
    document.querySelectorAll('#ext-custom-rows .ext-custom-row').forEach(function(row) {
      const name = ((row.querySelector('.ext-custom-name') || {}).value || '').trim();
      const priceRaw = ((row.querySelector('.ext-custom-price') || {}).value || '').trim();
      const price = parseFloat(priceRaw) || 0;
      const hasName = name.length > 0;
      const hasPrice = priceRaw.length > 0 && price > 0;
      if (!hasName && !hasPrice) return;
      if (hasName && !hasPrice) { customRowError = customRowError || ('Custom Selection Allowance "' + name + '" is missing a price.'); return; }
      if (!hasName && hasPrice) { customRowError = customRowError || 'A Custom Selection Allowance row has a price but no name.'; return; }
      customItems.push({ name: name, unitCost: price });
    });
    if (customRowError) throw new Error(customRowError);

    // Store gathered items/site-options/custom-allowances and hand off to
    // the shared tab-picker + write flow (tabpicker.html/tabpicker.js) —
    // the same one used by guided takeoff, base plan, and the webpage.
    // pendingNotifyEstimator/pendingNotifyItemNames explicitly cleared —
    // that feature is webpage-only (set exclusively by background.js's
    // OPEN_ESTIMATE_TAB_PICKER handler); chrome.storage.session.set merges
    // with existing keys, so a prior webpage-triggered write's flags would
    // otherwise leak into this extension-native one.
    await chrome.storage.session.set({
      pendingEstimateItems: items,
      pendingCustomItems: customItems,
      pendingSiteOptions: siteOptions,
      pendingClientPreview: false,
      pendingSlowConnection: slowConnection,
      pendingNotifyEstimator: false,
      pendingNotifyItemNames: []
    });
    await chrome.windows.create({
      url: chrome.runtime.getURL('tabpicker.html'),
      type: 'popup', width: 560, height: 520
    });
    log('Found ' + items.length + ' items. Pick a tab in the new window to write into.');
    showStatus('Pick a BuilderTrend Estimate tab in the new window…', 'success', 5000);

  } catch(e) {
    log('ERROR: ' + e.message);
    showStatus('Write to Estimate failed: ' + e.message, 'error', 8000);
  } finally {
    btn.disabled = false; btn.textContent = 'Write to Estimate';
  }
}

// ── Proposal Group Selector ────────────────────────────────────────────────
let _proposalSelectResolve = null;

function showProposalSelector(groups) {
  return new Promise(function(resolve) {
    _proposalSelectResolve = resolve;
    var el = $('proposal-select');
    var list = $('proposal-select-list');
    if (!el || !list) { resolve(null); return; }
    list.innerHTML = '';
    groups.forEach(function(g) {
      var row = document.createElement('label');
      row.className = 'proposal-select-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.groupName = g.name;
      var nameSpan = document.createElement('span');
      nameSpan.className = 'proposal-select-name';
      nameSpan.textContent = g.name;
      var amtSpan = document.createElement('span');
      amtSpan.className = 'proposal-select-amount';
      amtSpan.textContent = g.amount || '';
      row.appendChild(cb); row.appendChild(nameSpan); row.appendChild(amtSpan);
      list.appendChild(row);
    });
    el.classList.remove('hidden');
    el.scrollIntoView({ behavior: 'smooth' });
  });
}

function resolveProposalSelector() {
  var list = $('proposal-select-list');
  var cbs = Array.from((list || document).querySelectorAll('input[type="checkbox"]'));
  var kept    = cbs.filter(function(c){ return  c.checked; }).map(function(c){ return c.dataset.groupName; });
  var removed = cbs.filter(function(c){ return !c.checked; }).map(function(c){ return c.dataset.groupName; });
  $('proposal-select')?.classList.add('hidden');
  if (_proposalSelectResolve) { var r = _proposalSelectResolve; _proposalSelectResolve = null; r({ kept, removed }); }
}

// ── Navigation: Proposal View → Estimate Page (for future use) ──────────────────
// This function navigates back from proposal/client preview to the estimate page
// and handles the "Unsaved changes" Save modal. Call this when returning from proposal view.
//
// Navigation Steps:
// 1. Click back link: [data-testid="jobProposalPresentationalHeader-back-link"]
// 2. Wait for "Unsaved changes" modal (.ant-modal-confirm-title)
// 3. Click Save button in modal
// 4. Wait 1500ms for modal to close
// 5. Wait 2500ms for estimate page to reload
//
// async function goBackAndSave(tabId, log) {
//   await chrome.scripting.executeScript({
//     target: { tabId }, world: 'MAIN',
//     func: async function() {
//       function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
//       function waitFor(fn, ms) {
//         return new Promise(function(res, rej) {
//           var end = Date.now() + (ms || 5000);
//           (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
//         });
//       }
//       var back = document.querySelector('[data-testid="jobProposalPresentationalHeader-back-link"]');
//       if (!back) { console.warn('[Keel] back link not found'); return; }
//       back.click();
//       var modal = await waitFor(function() {
//         var t = document.querySelector('.ant-modal-confirm-title');
//         return (t && t.textContent.trim() === 'Unsaved changes') ? t : null;
//       }, 4000).catch(function(){ return null; });
//       if (modal) {
//         var saveBtn = Array.from(document.querySelectorAll('.ant-modal-confirm button, .ant-modal-footer button, .BTConfirm button'))
//           .find(function(b){ return b.textContent.trim() === 'Save'; });
//         if (saveBtn) { saveBtn.click(); }
//         await delay(1500);
//       }
//     }
//   }).catch(function(e){ log('⚠ Back/save error: ' + e.message); });
//   await new Promise(function(r){ setTimeout(r, 2500); });
// }

async function runClientPreviewFlow(tabId, log, setLabel) {
  function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

  // Step 0: Read grand total from estimate footer (before navigating away)
  log('Reading estimate grand total…');
  var _totalRes = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: function() {
      var span = document.querySelector('.BTGridFooterCell--ellipsis span[dir="ltr"]');
      if (!span) return 0;
      var txt = (span.innerText || '').trim();
      var m = txt.match(/^\$([\d,]+\.?\d*)$/);
      return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
    }
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
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
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
    }
  });
  var _estFlags = (_estFlagsRes && _estFlagsRes[0] && _estFlagsRes[0].result) || { lenderQtyPositive: false, customHasItems: false };
  log('Estimate check: lender qty>0=' + _estFlags.lenderQtyPositive + ', custom allowance items=' + _estFlags.customHasItems + ' ' + JSON.stringify(_estFlags.debug || {}));

  // Step 1: Click buildProposal button
  log('Opening proposal builder…');
  setLabel('Opening proposal…');
  var _buildBtnRes = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      var btn = document.querySelector('[data-testid="buildProposal"]');
      if (btn) { btn.click(); return { found: true }; }
      return { found: false, url: window.location.href };
    }
  });
  var _buildBtnStatus = _buildBtnRes && _buildBtnRes[0] && _buildBtnRes[0].result;
  if (_buildBtnStatus && !_buildBtnStatus.found) {
    log('⚠ "Build Proposal" button not found on this tab (url: ' + _buildBtnStatus.url + ')');
  }
  await delay(2500);

  // Step 1.5: Fill editor1 (intro) and editor2 (closing) via CKEditor API
  if (_grandTotal > 0) {
    log('Filling proposal editors…');
    setLabel('Writing proposal text…');
    var _lowFmt  = '$' + Math.round(_grandTotal * 0.99).toLocaleString('en-US');
    var _highFmt = '$' + Math.round(_grandTotal * 1.10).toLocaleString('en-US');
    var _midFmt  = '$' + Math.round(_grandTotal).toLocaleString('en-US');

    // Sales notes intentionally NOT read/written for this button (PBCP via
    // the static extension popup) — _salesNotesText stays '' so _notesBlock
    // below falls through to its existing empty-notes path unchanged.
    var _salesNotesText = '';

    var _notesBlock = '';
    if (_salesNotesText) {
      var _noteLines = _salesNotesText.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
      var _notesBody = _noteLines.map(function(l){
        return l.startsWith('-') ? '<li>' + l.slice(1).trim() + '</li>' : '<p>' + l + '</p>';
      }).join('');
      if (_noteLines.some(function(l){ return l.startsWith('-'); })) _notesBody = '<ul>' + _notesBody + '</ul>';
      _notesBlock = '<p>&nbsp;</p><h2><span style="font-size:16px;"><strong>NOTES</strong></span></h2><hr />' + _notesBody;
    }

    // Build HTML here (outside executeScript) so the serialized function stays small
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
      target: { tabId }, world: 'MAIN',
      func: async function(introHtml, closingHtml) {
        function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
        // Fill proposal title
        var titleInput = document.querySelector('#title[data-testid="title"]');
        if (titleInput) {
          var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(titleInput, 'Preliminary Budget Estimate');
          titleInput.dispatchEvent(new Event('input', { bubbles: true }));
          titleInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Wait for CKEditor instances to be ready
        var waited = 0;
        while (waited < 8000) {
          if (window.CKEDITOR && CKEDITOR.instances && Object.keys(CKEDITOR.instances).length >= 2) break;
          await delay(300);
          waited += 300;
        }
        if (!window.CKEDITOR) return;
        var editorKeys = Object.keys(CKEDITOR.instances);
        if (editorKeys.length < 2) return;
        var editorA = CKEDITOR.instances[editorKeys[0]];
        var editorB = CKEDITOR.instances[editorKeys[1]];

        // Show content visually in the editors
        editorA.setData(introHtml);
        editorB.setData(closingHtml);
        await delay(300);

        // Get jobId from already-loaded network resources
        var jobId = null;
        var resources = performance.getEntriesByType('resource');
        for (var ri = 0; ri < resources.length; ri++) {
          var rm = resources[ri].name.match(/\/apix\/v2\/Proposals\/draft\?jobId=(\d+)/);
          if (rm) { jobId = rm[1]; break; }
        }

        console.log('[Keel] jobId found:', jobId);
        if (jobId) {
          // GET current draft via XHR (bypasses BT's patched window.fetch)
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
          if (!draft) {
            console.log('[Keel] GET failed — falling back to Save button');
            var saveBtn = document.querySelector('[data-testid="save"]');
            if (saveBtn) { saveBtn.click(); await delay(3000); }
          } else {
            console.log('[Keel] GET ok');
            console.log('[Keel] GET top-level keys:', JSON.stringify(Object.keys(draft)));
            // Merge all sub-objects into one flat object (proposal + settings + jobInfo)
            var putBody = {};
            Object.keys(draft).forEach(function(k) {
              if (draft[k] && typeof draft[k] === 'object' && !Array.isArray(draft[k])) {
                Object.assign(putBody, draft[k]);
              }
            });
            // GET uses different field names than PUT — remap them
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
            // Rename items→lineItems inside each category (GET uses 'items', PUT expects 'lineItems')
            if (Array.isArray(putBody.categories)) {
              putBody.categories.forEach(function(cat) {
                if (cat.items && !cat.lineItems) {
                  cat.lineItems = cat.items;
                  delete cat.items;
                }
              });
            }
            // Don't change signature settings — always send as no-signatures-required
            putBody.requireSignatures = false;
            putBody.requiredSignatureUsers = [];
            // columnsToDisplay in GET is {type,value:[],options,validators}; PUT wants the array directly
            if (putBody.columnsToDisplay && Array.isArray(putBody.columnsToDisplay.value)) {
              putBody.columnsToDisplay = putBody.columnsToDisplay.value;
            }
            console.log('[Keel] requireSignatures:', putBody.requireSignatures, '| columnsToDisplay is array:', Array.isArray(putBody.columnsToDisplay));
            putBody.introductionText = introHtml;
            putBody.closingText = closingHtml;
            var bodyStr = JSON.stringify(putBody);
            console.log('[Keel] Sending via XHR, body size:', bodyStr.length);

            // Use XHR instead of fetch — BT patches window.fetch which truncates our body
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
            await delay(1500);
            // Re-apply editor content after PUT — React may have reset editors during XHR
            editorA.setData(introHtml);
            editorB.setData(closingHtml);
            await delay(300);
          }
        } else {
          console.log('[Keel] jobId NOT found — falling back to Save button');
          var saveBtn = document.querySelector('[data-testid="save"]');
          if (saveBtn) { saveBtn.click(); await delay(3000); }
        }
      },
      args: [_introHtml, _closingHtml]
    });
    var _saveResult = _editorResult && _editorResult[0] && _editorResult[0].result;
    log('Proposal save result: ' + JSON.stringify(_saveResult));
    // Verify our content is still on server before navigating to Client Preview
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: async function() {
        var resources = performance.getEntriesByType('resource');
        var jobId = null;
        for (var ri = 0; ri < resources.length; ri++) {
          var rm = resources[ri].name.match(/\/apix\/v2\/Proposals\/draft\?jobId=(\d+)/);
          if (rm) { jobId = rm[1]; break; }
        }
        if (!jobId) return;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/apix/v2/Proposals/draft?jobId=' + jobId, false); // sync
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
    // Uncheck "Collect signatures" if it is currently checked
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
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

    // Click BT's own Save button before switching to Client Preview — the raw
    // PUT above patches the draft record, but Save may be what triggers BT to
    // regenerate whatever rendered/published snapshot Client Preview actually
    // reads from.
    log('Clicking Save…');
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: function() {
        var saveBtn = document.querySelector('[data-testid="save"]');
        if (saveBtn) { saveBtn.click(); return { found: true }; }
        return { found: false };
      }
    });
    await delay(2000);

    // Lock our text back in AFTER Save — BT's own Save handler may read
    // introductionText/closingText from a React/Redux copy hydrated when
    // "Build Proposal" first loaded (before our PUT ever ran), not from
    // CKEditor's live buffer. Re-run the same full GET -> PUT with our HTML,
    // last, right before the reload, so our text is guaranteed to be what
    // the server actually holds afterward.
    log('Locking proposal text after Save…');
    var _lockResult = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: async function(introHtml, closingHtml) {
        function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
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
      args: [_introHtml, _closingHtml]
    });
    var _lockDbgResult = _lockResult && _lockResult[0] && _lockResult[0].result;
    log('Lock result: ' + JSON.stringify(_lockDbgResult));

    // The proposal page's React app still holds the pre-save proposal object
    // in memory (fetched when "Build Proposal" was first clicked, before our
    // PUT ever ran). Reload — focusing the tab first so the reload isn't
    // throttled in the background — so BT re-fetches fresh data (including
    // what we just saved) before we switch to the Client Preview tab.
    log('Reloading proposal page to sync saved text…');
    await chrome.tabs.update(tabId, { active: true });
    await delay(200);
    await chrome.tabs.reload(tabId);
    await new Promise(function (resolve) {
      function checkStatus() {
        chrome.tabs.get(tabId, function (t) {
          if (t && t.status === 'complete') { resolve(); } else { setTimeout(checkStatus, 300); }
        });
      }
      setTimeout(checkStatus, 800);
    });
    await delay(2500);
  }

  // Step 2: Click Client Preview tab
  log('Navigating to client preview…');
  var previewResult = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      function waitFor(fn, ms) {
        return new Promise(function(res, rej) {
          var end = Date.now() + (ms || 6000);
          (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
        });
      }
      var tab = await waitFor(function() {
        var el = document.querySelector('[data-testid="jobProposalClientPreviewTab"]');
        return (el && el.offsetParent !== null) ? el : null;
      }, 6000).catch(function(){ return null; });
      if (!tab) return { ok: false, error: 'Client Preview tab not found' };
      tab.click();
      return { ok: true };
    }
  });
  var pr = previewResult && previewResult[0] && previewResult[0].result;
  if (pr && !pr.ok) throw new Error(pr.error || 'Could not open client preview');
  await delay(2000);

  // Step 3: Edit Display to client — remove Cost code, Parent group price, Unit price; add Item title, Description
  log('Configuring display settings…');
  setLabel('Setting display…');
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      function waitFor(fn, ms) {
        return new Promise(function(res, rej) {
          var end = Date.now() + (ms || 5000);
          (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
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
        // Close dropdown
        document.body.click();
        await delay(200);
      }

      // Remove unwanted columns
      removeTag('Cost code');    await delay(200);
      removeTag('Parent group price'); await delay(200);
      removeTag('Unit price');   await delay(200);

      // Add missing columns (no-op if already present)
      var existing = Array.from(document.querySelectorAll('.ant-select-selection-item-content')).map(function(el){ return el.textContent.trim().toLowerCase(); });
      if (!existing.includes('item title'))   await addOption('Item title');
      if (!existing.includes('description'))  await addOption('Description');
    }
  });
  await delay(1000);

  // Step 4: Collapse all groups EXCEPT Selection Allowance & Site Allowance
  // (expand those two if they're collapsed)
  log('Configuring groups…');
  setLabel('Configuring groups…');
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function(estLenderQty, estCustomItems) {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
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

      // Also keep Preferred Lender Incentive / Custom Selection Allowances
      // expanded if they actually have items in them (count shown in the
      // group title, e.g. "Preferred Lender Incentive (1)"). Custom Selection
      // Allowances additionally requires at least one item that isn't just
      // "Place Holder" — if that's the only thing in it, leave it collapsed.
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

      // Step 1: Collapse all expanded groups EXCEPT the ones we want to keep
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

      // Step 2: Expand any groups in KEEP_EXPANDED that are collapsed
      var allItems = Array.from(document.querySelectorAll('.ant-collapse-item.ProposalGroup'));
      for (var j = 0; j < allItems.length; j++) {
        var nameEl2 = allItems[j].querySelector('h3.ant-typography');
        var name2 = nameEl2 ? nameEl2.textContent.trim().toLowerCase() : '';
        var cleanName2 = parseGroupName(name2).name;
        var shouldExpand = KEEP_EXPANDED.some(function(k) { return cleanName2 === k; });
        if (shouldExpand) {
          // Check if currently collapsed (no ant-collapse-item-active class)
          var isCollapsed = !allItems[j].classList.contains('ant-collapse-item-active');
          if (isCollapsed) {
            var header2 = allItems[j].querySelector('.ant-collapse-header');
            if (header2) { header2.click(); await delay(200); }
          }
        }
      }
    },
    args: [_estFlags.lenderQtyPositive, _estFlags.customHasItems]
  });
  await delay(800);

  log('✓ Client preview setup complete');
  setLabel('Done');
}

async function startClientPreview() {
  const btn = $('btn-client-preview');
  const logEl = $('estimate-log');
  btn.disabled = true; btn.textContent = 'Working…';
  logEl.textContent = ''; logEl.classList.remove('hidden');
  function log(msg) { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; }

  try {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(function(t){ return t.url && t.url.includes('buildertrend') && t.url.toLowerCase().includes('estimate'); })
             || tabs.find(function(t){ return t.url && t.url.includes('buildertrend'); });
    if (!tab) throw new Error('No BuilderTrend Estimate tab found.');
    await runClientPreviewFlow(tab.id, log, function(t){ btn.textContent = t; });
  } catch(e) {
    log('ERROR: ' + e.message);
    showStatus('Client Preview failed: ' + e.message, 'error', 8000);
  } finally {
    btn.disabled = false; btn.textContent = 'Start Prelim - Budget Client Preview';
  }
}

async function runM1ClientPreviewFlow(tabId, log, setLabel) {
  function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

  // Step 0.5: Check the Estimate grid (before Build Proposal is clicked) for
  // (a) "Preferred Lender Incentive" qty > 0, and (b) any real item already
  // written under "Custom Selection Allowances". These feed the group-expand
  // step below as EXTRA reasons to expand a section — additive to, not a
  // replacement for, the existing rendered-panel-title check there.
  log('Checking estimate for lender/custom-allowance items…');
  var _estFlagsRes = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
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
    }
  });
  var _estFlags = (_estFlagsRes && _estFlagsRes[0] && _estFlagsRes[0].result) || { lenderQtyPositive: false, customHasItems: false };
  log('Estimate check: lender qty>0=' + _estFlags.lenderQtyPositive + ', custom allowance items=' + _estFlags.customHasItems + ' ' + JSON.stringify(_estFlags.debug || {}));

  // Step 1: Click buildProposal button
  log('Opening proposal builder…');
  setLabel('Opening proposal…');
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      var btn = document.querySelector('[data-testid="buildProposal"]');
      if (btn) btn.click();
    }
  });
  await delay(2500);

  // Step 2: Click Client Preview tab
  log('Navigating to client preview…');
  var previewResult = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      function waitFor(fn, ms) {
        return new Promise(function(res, rej) {
          var end = Date.now() + (ms || 6000);
          (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
        });
      }
      var tab = await waitFor(function() {
        var el = document.querySelector('[data-testid="jobProposalClientPreviewTab"]');
        return (el && el.offsetParent !== null) ? el : null;
      }, 6000).catch(function(){ return null; });
      if (!tab) return { ok: false, error: 'Client Preview tab not found' };
      tab.click();
      return { ok: true };
    }
  });
  var pr = previewResult && previewResult[0] && previewResult[0].result;
  if (pr && !pr.ok) throw new Error(pr.error || 'Could not open client preview');
  await delay(2000);

  // Step 3: Edit Display to client — remove Cost code, Parent group price, Unit price; add Item title, Description
  log('Configuring display settings…');
  setLabel('Setting display…');
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function() {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      function waitFor(fn, ms) {
        return new Promise(function(res, rej) {
          var end = Date.now() + (ms || 5000);
          (function tick(){ var v = fn(); if (v) return res(v); if (Date.now() > end) return rej(new Error('timeout')); setTimeout(tick, 150); })();
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
      removeTag('Cost code');        await delay(200);
      removeTag('Parent group price'); await delay(200);
      removeTag('Unit price');       await delay(200);
      var existing = Array.from(document.querySelectorAll('.ant-select-selection-item-content')).map(function(el){ return el.textContent.trim().toLowerCase(); });
      if (!existing.includes('item title'))  await addOption('Item title');
      if (!existing.includes('description')) await addOption('Description');
    }
  });
  await delay(1000);

  // Step 4: Collapse all groups EXCEPT Selection Allowance & Site Allowance
  log('Configuring groups…');
  setLabel('Configuring groups…');
  await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: async function(estLenderQty, estCustomItems) {
      function delay(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
      function parseGroupName(raw) {
        var m = raw.match(/^(.*?)\s*\((\d+)\)\s*$/);
        return m ? { name: m[1].trim(), count: parseInt(m[2], 10) } : { name: raw, count: 0 };
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
      precheckItems.forEach(function(it) {
        var nEl = it.querySelector('h3.ant-typography');
        var raw = nEl ? nEl.textContent.trim().toLowerCase() : '';
        var parsed = parseGroupName(raw);
        if (parsed.count > 0 && (parsed.name === 'preferred lender incentive' || parsed.name === 'custom selection allowances')) {
          if (KEEP_EXPANDED.indexOf(parsed.name) === -1) KEEP_EXPANDED.push(parsed.name);
        }
      });
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
    args: [_estFlags.lenderQtyPositive, _estFlags.customHasItems]
  });
  await delay(800);

  log('✓ Client preview setup complete');
  setLabel('Done');
}

async function startM1ClientPreview() {
  const btn = $('btn-m1-client-preview');
  const logEl = $('estimate-log');
  btn.disabled = true; btn.textContent = 'Working…';
  logEl.textContent = ''; logEl.classList.remove('hidden');
  function log(msg) { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; }
  try {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(function(t){ return t.url && t.url.includes('buildertrend') && t.url.toLowerCase().includes('estimate'); })
             || tabs.find(function(t){ return t.url && t.url.includes('buildertrend'); });
    if (!tab) throw new Error('No BuilderTrend Estimate tab found.');
    await runM1ClientPreviewFlow(tab.id, log, function(t){ btn.textContent = t; });
  } catch(e) {
    log('ERROR: ' + e.message);
    showStatus('M1 Client Preview failed: ' + e.message, 'error', 8000);
  } finally {
    btn.disabled = false; btn.textContent = 'Start M1 Client Preview';
  }
}

// ── Write helpers ─────────────────────────────────────────────────────────────

async function writeValues(values) {
  showStatus('Writing to database…', 'info', 0);
  try {
    const res = await sendMsg('WRITE_VALUES', { values: values });
    showStatus('✓ Wrote ' + res.written + ' value(s) to database', 'success');
    setTimeout(function() { loadSheetTab(activeTab); }, 1000);
  } catch (e) {
    showStatus('Error: ' + e.message, 'error', 6000);
  }
}

// ── Sheet display ─────────────────────────────────────────────────────────────

let activeTab = 'fixed-costs';
const TAB_HEADERS = ['Cost Code', 'Item', 'Type', 'Quantity', 'Amount', 'Unit Cost'];
const TAB_ORDER   = ['fixed-costs', 'finished-unfinished', 'areas', 'allowances-permits'];

async function loadSheetTab(tab) {
  $('sheet-loading').classList.remove('hidden');
  $('sheet-content').classList.add('hidden');
  $('sheet-error').classList.add('hidden');
  try {
    const res = await sendMsg('GET_TAB_DATA', { tab: tab });
    renderTable(res.rows);
    $('sheet-loading').classList.add('hidden');
    $('sheet-content').classList.remove('hidden');
    applySheetZoom();
  } catch (e) {
    $('sheet-loading').classList.add('hidden');
    $('sheet-error').textContent = 'Error: ' + e.message;
    $('sheet-error').classList.remove('hidden');
  }
}

function renderTable(rows) {
  const thead = $('sheet-thead'), tbody = $('sheet-tbody');
  thead.innerHTML = '';
  const hr = document.createElement('tr');
  TAB_HEADERS.forEach(function(h) { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
  thead.appendChild(hr);
  tbody.innerHTML = '';
  if (!rows || !rows.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = 6; td.textContent = 'No data'; td.style.cssText = 'text-align:center;padding:16px;color:#a0aec0';
    tr.appendChild(td); tbody.appendChild(tr); return;
  }
  rows.forEach(function(row) {
    if (row.every(function(c) { return !c || !c.toString().trim(); })) return;
    const tr = document.createElement('tr');
    const b2 = (row[1] || '').toString().trim();
    if (!row[0] && b2 === b2.toUpperCase() && b2.length > 3) tr.classList.add('row-total');
    for (let i = 0; i < 6; i++) {
      const td = document.createElement('td');
      let v = row[i] !== undefined ? row[i] : '';
      if ((i === 4 || i === 5) && v) {
        const n = parseFloat(v.toString().replace(/[$,]/g, ''));
        if (!isNaN(n) && n !== 0) v = '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      td.textContent = v;
      if (!v || v === '0') td.style.color = '#cbd5e0';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
}

// ── Sheet zoom ────────────────────────────────────────────────────────────────

const SHEET_ZOOM_STEPS = [60, 70, 80, 90, 100, 110, 120];
let sheetZoomIdx = 4;

function applySheetZoom() {
  const pct   = SHEET_ZOOM_STEPS[sheetZoomIdx];
  const table = $('sheet-table');
  if (table) table.style.fontSize = (pct / 100 * 11) + 'px';
  const szPct = $('sz-pct');
  if (szPct) szPct.textContent = pct + '%';
}

function switchToTab(tabKey) {
  document.querySelectorAll('.tab-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tab === tabKey);
  });
  activeTab = tabKey;
  loadSheetTab(activeTab);
  updateArrows();
}

function updateArrows() {
  const idx  = TAB_ORDER.indexOf(activeTab);
  const prev = $('tab-prev'), next = $('tab-next');
  if (prev) prev.disabled = (idx === 0);
  if (next) next.disabled = (idx === TAB_ORDER.length - 1);
}

// ── Sequential Post-Takeoff Actions ───────────────────────────────────────────
// Manages workflow: Grab & Write → Write to Estimate → Start Client Preview

let seqState = { currentStep: null, isProcessing: false };

function showSeqActions() {
  const tkWriteBtn = $('btn-tk-write');
  const seqActionsEl = $('seq-actions');
  if (tkWriteBtn) tkWriteBtn.classList.add('hidden');
  if (seqActionsEl) seqActionsEl.classList.remove('hidden');
  seqState.currentStep = 'write-estimate';
  showSeqButton('write-estimate');
}

function showSeqButton(step) {
  const estimateBtn = $('btn-seq-write-estimate');
  const previewBtn = $('btn-seq-client-preview');
  const loadingEl = $('seq-loading');

  if (estimateBtn) estimateBtn.classList.add('hidden');
  if (previewBtn) previewBtn.classList.add('hidden');
  if (loadingEl) loadingEl.classList.add('hidden');

  seqState.currentStep = step;
  seqState.isProcessing = false;
  if (step === 'write-estimate' && estimateBtn) estimateBtn.classList.remove('hidden');
  if (step === 'client-preview' && previewBtn) previewBtn.classList.remove('hidden');
}

function showSeqLoading(text) {
  const estimateBtn = $('btn-seq-write-estimate');
  const previewBtn = $('btn-seq-client-preview');
  const loadingEl = $('seq-loading');
  const loadingText = $('seq-loading-text');

  if (estimateBtn) estimateBtn.classList.add('hidden');
  if (previewBtn) previewBtn.classList.add('hidden');
  if (loadingEl) {
    loadingEl.classList.remove('hidden');
    if (loadingText) loadingText.textContent = text || 'Processing…';
  }
  seqState.isProcessing = true;
}

function hideSeqActions() {
  const tkWriteBtn = $('btn-tk-write');
  const seqActionsEl = $('seq-actions');
  if (tkWriteBtn) tkWriteBtn.classList.remove('hidden');
  if (seqActionsEl) seqActionsEl.classList.add('hidden');
  seqState.currentStep = null;
  seqState.isProcessing = false;
}

function completeSeqActions() {
  const seqActionsEl = $('seq-actions');
  if (seqActionsEl) seqActionsEl.classList.add('hidden');
  seqState.currentStep = null;
  seqState.isProcessing = false;
}

async function seqWriteToEstimate() {
  showSeqLoading('Writing to Estimate…');
  try {
    await writeToEstimate();
    showSeqButton('client-preview');
  } catch (err) {
    console.error('Sequential write to estimate failed:', err);
    hideSeqActions();
  }
}

async function seqClientPreview() {
  showSeqLoading('Starting Client Preview…');
  try {
    await startClientPreview();
    completeSeqActions();
  } catch (err) {
    console.error('Sequential client preview failed:', err);
    hideSeqActions();
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Write to Estimate — click only; block Enter/Space so it can't be triggered via keyboard
  // (only the post-write-to-sheet sequential button responds to Enter)
  $('btn-write-estimate').addEventListener('click', writeToEstimate);
  $('btn-write-estimate').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); e.stopPropagation(); }
  });
  $('btn-proposal-done')?.addEventListener('click', resolveProposalSelector);
  $('btn-client-preview')?.addEventListener('click', startClientPreview);
  $('btn-m1-client-preview')?.addEventListener('click', startM1ClientPreview);

  // Manual entry
  $('btn-write-manual').addEventListener('click', function() {
    const values = {};
    document.querySelectorAll('.manual-row input').forEach(function(inp) {
      if (inp.value.trim()) values[inp.dataset.key] = parseFloat(inp.value);
    });
    if (!Object.keys(values).length) { showStatus('No values entered', 'error', 3000); return; }
    writeValues(values);
  });
  $('btn-clear-manual').addEventListener('click', function() {
    document.querySelectorAll('.manual-row input').forEach(function(i) { i.value = ''; });
  });

  // Sheet tabs & arrows
  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { switchToTab(btn.dataset.tab); });
  });
  const prevBtn = $('tab-prev'), nextBtn = $('tab-next');
  if (prevBtn) prevBtn.addEventListener('click', function() {
    const idx = TAB_ORDER.indexOf(activeTab);
    if (idx > 0) switchToTab(TAB_ORDER[idx - 1]);
  });
  if (nextBtn) nextBtn.addEventListener('click', function() {
    const idx = TAB_ORDER.indexOf(activeTab);
    if (idx < TAB_ORDER.length - 1) switchToTab(TAB_ORDER[idx + 1]);
  });
  updateArrows();

  // Sheet zoom
  $('btn-sz-out') && $('btn-sz-out').addEventListener('click', function() {
    if (sheetZoomIdx > 0) { sheetZoomIdx--; applySheetZoom(); chrome.storage.local.set({ sheetZoomIdx: sheetZoomIdx }); }
  });
  $('btn-sz-in') && $('btn-sz-in').addEventListener('click', function() {
    if (sheetZoomIdx < SHEET_ZOOM_STEPS.length - 1) { sheetZoomIdx++; applySheetZoom(); chrome.storage.local.set({ sheetZoomIdx: sheetZoomIdx }); }
  });
  chrome.storage.local.get('sheetZoomIdx', function(s) {
    if (s.sheetZoomIdx !== undefined) { sheetZoomIdx = s.sheetZoomIdx; applySheetZoom(); }
  });

  // Settings & refresh
  $('btn-open-admin').addEventListener('click', function() { chrome.tabs.create({ url: 'https://urbancoreai.github.io/KeelEZEstimate/admin/' }); });
  $('btn-open-ezestimate').addEventListener('click', function() { chrome.tabs.create({ url: 'https://UrbanCoreAI.github.io/KeelEZEstimate/' }); });
  $('btn-settings').addEventListener('click', function() { chrome.runtime.openOptionsPage(); });
  $('btn-refresh-sheet').addEventListener('click', function() { loadSheetTab(activeTab); });

  // Open Sheet button — opens the Google Sheet in a new tab
  var btnOpenSheet = $('btn-open-sheet');
  if (btnOpenSheet) {
    btnOpenSheet.addEventListener('click', function(e) {
      e.stopPropagation(); // don't toggle the <details>
      sendMsg('CHECK_AUTH').then(function(auth) {
        var sid = auth && auth.sheetId;
        if (sid) {
          chrome.tabs.create({ url: 'https://docs.google.com/spreadsheets/d/' + sid });
        } else {
          showStatus('No sheet configured — add Sheet ID in ⚙ Settings', 'error', 4000);
        }
      });
    });
  }

  // Load sheet only when the details panel is first opened
  var sheetDetails = $('sheet-details');
  var sheetLoaded = false;
  if (sheetDetails) {
    sheetDetails.addEventListener('toggle', function() {
      if (sheetDetails.open && !sheetLoaded) {
        sheetLoaded = true;
        $('sheet-loading').classList.remove('hidden');
        loadSheetTab(activeTab);
      }
    });
  }

  // Check auth (no auto-load sheet)
  try {
    const auth = await sendMsg('CHECK_AUTH');
    if (!auth.hasClientId || !auth.hasSheetId) {
      $('sheet-error').textContent = 'Configure Google Client ID in ⚙ Settings to see sheet data.';
      $('sheet-error').classList.remove('hidden');
    }
  } catch (e) {
    $('sheet-error').textContent = 'Setup error: ' + e.message;
    $('sheet-error').classList.remove('hidden');
  }

  // Sequential post-takeoff buttons
  $('btn-seq-write-estimate')?.addEventListener('click', seqWriteToEstimate);
  $('btn-seq-client-preview')?.addEventListener('click', seqClientPreview);

  // NOTE: Enter key handling for the workflow buttons (btn-tk-done, btn-tk-write-estimate)
  // is handled entirely inside takeoff-workflow.js to avoid race conditions.
  // The Grab & Write to Sheet button (btn-tk-write) must only be triggered by explicit mouse click.

  // Enter key: allow Grab & Write to Sheet ONLY when tk-complete is actually visible.
  // (btn-tk-write lives inside tk-complete, which is hidden during active takeoff steps.
  //  Checking the parent prevents a stray Enter from the last takeoff step triggering it.)
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return;
    const tkCompleteDiv = document.getElementById('tk-complete');
    const tkBtn = $('btn-tk-write');
    if (tkCompleteDiv && !tkCompleteDiv.classList.contains('hidden') &&
        tkBtn && !tkBtn.disabled) {
      tkBtn.click();
      e.preventDefault();
    }
  });
}

document.addEventListener('DOMContentLoaded', init); /* Auto-Update: wires the "Check for Updates" button in panel.html/popup.html to EZUpdateManager (update-manager.js), loaded just before this file on both pages. */(function(){var btn=document.getElementById('btn-check-update');var statusText=document.getElementById('update-status-text');var actionLink=document.getElementById('update-action-link');if(!btn||!statusText)return;var PROGRESS_LABELS={checking:'Checking for updates...',downloading:'Downloading update...',unzipping:'Unpacking update...',writing:'Writing files...'};function setText(msg){statusText.textContent=msg;}function hideLink(){if(actionLink)actionLink.classList.add('hidden');}function showLink(label){if(!actionLink)return;actionLink.textContent=label;actionLink.classList.remove('hidden');actionLink.onclick=function(e){e.preventDefault();chrome.runtime.openOptionsPage();};}btn.addEventListener('click',async function(){var M=window.EZUpdateManager;if(!M){setText('Update system failed to load on this page.');return;}btn.disabled=true;hideLink();setText('Checking for updates...');try{var result=await M.checkAndApplyUpdate(function(stage){setText(PROGRESS_LABELS[stage]||'Working...');});if(result.status==='up-to-date'){setText('Up to date (v'+result.localVersion+').');btn.disabled=false;}else{setText('Updated to v'+result.newVersion+' - reloading...');if(chrome.action&&chrome.action.setBadgeText){chrome.action.setBadgeText({text:''});}setTimeout(function(){chrome.runtime.reload();},1200);}}catch(e){if(M.NoFolderSetError&&e instanceof M.NoFolderSetError){setText('No update folder set yet.');showLink('Set it up in Settings');}else if(M.PermissionError&&e instanceof M.PermissionError){setText('Update folder access needs to be re-authorized.');showLink('Fix in Settings');}else if(M.FolderMissingError&&e instanceof M.FolderMissingError){setText('Update folder could not be found.');showLink('Fix in Settings');}else{setText((e&&e.message)||'Update check failed.');}btn.disabled=false;}});})();
