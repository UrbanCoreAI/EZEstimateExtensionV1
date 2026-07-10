// viewer.js — annotated plan viewer logic (extracted from viewer.html inline script)

const CATS = {
  exterior_doors: { color: '#ef4444', label: 'Exterior Doors', short: 'ED' },
  windows:        { color: '#3b82f6', label: 'Windows',         short: 'W'  },
  baths:          { color: '#a855f7', label: 'Baths',           short: 'B'  },
  staircases:     { color: '#eab308', label: 'Staircases',      short: 'S'  },
  porch_columns:  { color: '#22c55e', label: 'Porch Columns',   short: 'C'  },
  garage_doors:   { color: '#f97316', label: 'Garage Doors',    short: 'G'  },
  interior_doors: { color: '#14b8a6', label: 'Interior Doors',  short: 'D'  },
};

const canvas  = document.getElementById('plan-canvas');
const svg     = document.getElementById('ann-svg');
const tooltip = document.getElementById('tooltip');
const wrap    = document.getElementById('plan-wrap');
let scale = 1;
let vis   = Object.fromEntries(Object.keys(CATS).map(k => [k, true]));

chrome.storage.local.get('annotationData', ({ annotationData }) => {
  if (!annotationData) {
    document.getElementById('loading').textContent = 'No annotation data found. Run analysis from the extension popup first.';
    return;
  }
  const { result, image, mime } = annotationData;
  loadImageAndAnnotate(image, mime, result);
});

function loadImageAndAnnotate(base64, mime, result) {
  const img = new Image();
  img.onload = () => {
    canvas.width  = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    document.getElementById('loading').remove();
    buildSVG(result, img.width, img.height);
    buildCounts(result);
    buildLegend();
    fitToScreen();
  };
  img.onerror = () => {
    document.getElementById('loading').textContent = 'Failed to load plan image.';
  };
  img.src = 'data:' + mime + ';base64,' + base64;
}

function buildSVG(result, W, H) {
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  const DRAW_ORDER = ['interior_doors','windows','porch_columns','staircases','garage_doors','baths','exterior_doors'];

  DRAW_ORDER.forEach(cat => {
    const locs = (result[cat] && result[cat].locations) || [];
    locs.forEach((loc, idx) => {
      const isSmall = cat === 'interior_doors' || cat === 'windows' || cat === 'porch_columns';
      const r   = isSmall ? 10 : 14;
      const col = CATS[cat].color;
      const x   = (loc.x / 100) * W;
      const y   = (loc.y / 100) * H;
      const lbl = cat === 'interior_doors' ? 'D'
                : cat === 'porch_columns'  ? String(idx + 1)
                : cat === 'staircases'     ? 'S'
                : cat === 'garage_doors'   ? 'G'
                : cat === 'baths'          ? String(idx + 1)
                : cat === 'exterior_doors' ? String(idx + 1)
                : String(idx + 1);

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.classList.add('ann');
      g.dataset.cat = cat;

      const shadow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      shadow.setAttribute('cx', x + 1); shadow.setAttribute('cy', y + 1);
      shadow.setAttribute('r', r); shadow.setAttribute('fill', 'rgba(0,0,0,0.35)');

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', x); circle.setAttribute('cy', y);
      circle.setAttribute('r', r); circle.setAttribute('fill', col);
      circle.setAttribute('stroke', 'rgba(255,255,255,0.7)'); circle.setAttribute('stroke-width', '1.5');

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x); text.setAttribute('y', y);
      text.setAttribute('text-anchor', 'middle'); text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('fill', 'white'); text.setAttribute('font-family', 'Arial');
      text.setAttribute('font-weight', 'bold');
      text.setAttribute('font-size', isSmall ? (lbl.length > 1 ? '7' : '8') : (lbl.length > 1 ? '9' : '11'));
      text.textContent = lbl;

      g.appendChild(shadow); g.appendChild(circle); g.appendChild(text);

      const tipText = CATS[cat].label + ' #' + (idx + 1) + (loc.note ? ' — ' + loc.note : '');
      g.addEventListener('mouseenter', e => {
        circle.setAttribute('r', r + 4);
        tooltip.style.display = 'block';
        tooltip.textContent = tipText;
        moveTooltip(e);
      });
      g.addEventListener('mousemove', moveTooltip);
      g.addEventListener('mouseleave', () => {
        circle.setAttribute('r', r);
        tooltip.style.display = 'none';
      });
      svg.appendChild(g);
    });
  });
}

function moveTooltip(e) {
  tooltip.style.left = (e.clientX + 14) + 'px';
  tooltip.style.top  = (e.clientY - 10) + 'px';
}

function buildCounts(result) {
  const bar = document.getElementById('counts-bar');
  Object.entries(CATS).forEach(function(entry) {
    const key = entry[0], cat = entry[1];
    const count = (result[key] && result[key].count !== undefined) ? result[key].count : '—';
    const chip = document.createElement('div');
    chip.className = 'count-chip';
    const num = document.createElement('span');
    num.className = 'num';
    num.style.color = cat.color;
    num.textContent = count;
    const lbl = document.createElement('span');
    lbl.textContent = cat.label;
    chip.appendChild(num); chip.appendChild(lbl);
    bar.appendChild(chip);
  });
}

function buildLegend() {
  const legendEl = document.getElementById('legend');
  Object.entries(CATS).forEach(function(entry) {
    const key = entry[0], cat = entry[1];
    const btn = document.createElement('button');
    btn.className = 'leg-btn';
    btn.style.borderColor = cat.color;
    const dot = document.createElement('span');
    dot.className = 'leg-dot';
    dot.style.background = cat.color;
    dot.textContent = cat.short;
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(cat.label));
    btn.addEventListener('click', function() {
      vis[key] = !vis[key];
      btn.classList.toggle('off', !vis[key]);
      document.querySelectorAll('.ann[data-cat="' + key + '"]').forEach(function(el) {
        el.style.display = vis[key] ? '' : 'none';
      });
    });
    legendEl.appendChild(btn);
  });
}

function applyScale(s) {
  scale = Math.max(0.15, Math.min(5, s));
  wrap.style.transform = 'scale(' + scale + ')';
  wrap.style.width  = (canvas.width  * scale) + 'px';
  wrap.style.height = (canvas.height * scale) + 'px';
}

function fitToScreen() {
  const vp = document.getElementById('viewport');
  applyScale(Math.min(vp.clientWidth / canvas.width, vp.clientHeight / canvas.height) * 0.95);
}

document.getElementById('zin' ).addEventListener('click', function() { applyScale(scale * 1.2);  });
document.getElementById('zout').addEventListener('click', function() { applyScale(scale * 0.83); });
document.getElementById('zfit').addEventListener('click', fitToScreen);
document.getElementById('viewport').addEventListener('wheel', function(e) {
  e.preventDefault();
  applyScale(scale * (e.deltaY < 0 ? 1.1 : 0.9));
}, { passive: false });
