'use strict';
// Analytics: cost, energy and run time by equipment, per day or per month.

const $ = (id) => document.getElementById(id);
const MAX_SLOTS = 8; // categorical palette size; more series fold into "Other"
const RANGE_KEY = 'poolremote.analyticsRange';
let H = null;        // /local/energy/history response
let range = (() => { try { return localStorage.getItem(RANGE_KEY) || '30d'; } catch { return '30d'; } })();

const money = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(2)}`);
const kwh = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()} kWh`;
const hours = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.setAttribute('style', v);
    else n.setAttribute(k, v);
  }
  for (const k of kids) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
};
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

// Series with their fixed color slot (by position in the equipment list, never by rank).
function seriesList() {
  const list = H.series.map((s, i) => ({ ...s, color: i < MAX_SLOTS - 1 || H.series.length <= MAX_SLOTS ? `var(--series-${i + 1})` : null }));
  if (H.series.length <= MAX_SLOTS) return list;
  const kept = list.slice(0, MAX_SLOTS - 1);
  kept.push({ id: '__other', name: 'Other', color: 'var(--series-other)', fold: list.slice(MAX_SLOTS - 1).map((s) => s.id) });
  return kept;
}

function valueOf(row, s) {
  if (s.fold) return s.fold.reduce((a, id) => a + (row.values[id]?.cost || 0), 0);
  return row.values[s.id]?.cost || 0;
}

function bucketLabel(row, long = false) {
  if (H.group === 'month') return row.label;
  const d = new Date(row.key + 'T12:00:00');
  return d.toLocaleDateString([], long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
}

async function load() {
  $('chart').classList.add('loading'); // keep the previous frame while refetching
  try {
    const res = await fetch(`/local/energy/history?range=${encodeURIComponent(range)}`);
    if (!res.ok) throw new Error(`History unavailable (${res.status})`);
    H = await res.json();
    render();
  } catch (err) {
    $('chart').replaceChildren(el('p', { class: 'empty' }, err.message));
  } finally {
    $('chart').classList.remove('loading');
  }
}

function render() {
  for (const b of $('ranges').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.range === range));
  renderTiles();
  renderLegend();
  renderChart();
  renderChartTable();
  renderBreakdown();
  renderSpeeds();
}

function renderTiles() {
  const t = H.totals;
  const tile = (label, big, sub) => el('div', { class: 'tile4' },
    el('div', { class: 'label' }, label), el('div', { class: 'big' }, big), el('div', { class: 'sub' }, sub));
  $('tiles').replaceChildren(
    tile('Total cost', money(t.cost), t.daysWithData ? `${money(t.perDay)} per day · ${t.daysWithData} day${t.daysWithData === 1 ? '' : 's'} logged` : 'No data yet'),
    tile('Electricity', money(t.elecCost), kwh(t.kWh)),
    tile('Gas', money(t.gasCost), `${t.gasUnits.toFixed(t.gasUnits < 10 ? 2 : 0)} ${H.gas.unit}`),
    tile('Pump run time', hours(t.pumpSeconds || maxPumpSeconds()), 'measured or from equipment'),
  );
}

function maxPumpSeconds() {
  return H.series.filter((s) => s.category === 'pump').reduce((m, s) => Math.max(m, H.totals.bySeries[s.id]?.seconds || 0), 0);
}

function renderLegend() {
  const ser = seriesList();
  $('legend').replaceChildren(...(ser.length > 1 ? ser.map((s) => el('span', {}, el('i', { style: `background:${s.color}` }), s.name)) : []));
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function renderChart() {
  const box = $('chart');
  $('chartTitle').textContent = H.group === 'month' ? 'Cost per month' : 'Cost per day';
  const rows = H.rows;
  const ser = seriesList();
  const totals = rows.map((r) => ser.reduce((a, s) => a + valueOf(r, s), 0));
  if (!totals.some((v) => v > 0)) {
    box.replaceChildren(el('p', { class: 'empty' }, H.since
      ? 'No usage recorded in this range yet.'
      : 'No data yet. Usage is recorded automatically while Pool Remote runs.'));
    return;
  }
  const W = Math.max(280, box.clientWidth || 320), Hh = 220;
  const m = { l: 44, r: 6, t: 8, b: 24 };
  const pw = W - m.l - m.r, ph = Hh - m.t - m.b;
  const ymax = niceMax(Math.max(...totals));
  const y = (v) => m.t + ph - (v / ymax) * ph;
  const band = pw / rows.length;
  const bw = Math.max(3, Math.min(24, band * 0.7));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${Hh}`, height: Hh, role: 'img', 'aria-label': `${$('chartTitle').textContent}, stacked by equipment` });

  // Gridlines + y ticks (clean $ values).
  for (let i = 0; i <= 4; i++) {
    const v = (ymax / 4) * i, yy = Math.round(y(v)) + 0.5;
    svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, stroke: i === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }));
    const t = svgEl('text', { x: m.l - 6, y: yy + 4, 'text-anchor': 'end', class: 'tick' });
    t.textContent = ymax < 10 ? `$${v.toFixed(v % 1 ? 2 : 0)}` : `$${Math.round(v)}`;
    svg.append(t);
  }

  // X labels: a handful, evenly spaced.
  const every = Math.ceil(rows.length / Math.max(1, Math.floor(pw / 56)));
  rows.forEach((r, i) => {
    if (i % every && i !== rows.length - 1) return;
    if (i !== rows.length - 1 && rows.length - 1 - i < every) return; // avoid colliding with the last label
    const t = svgEl('text', { x: m.l + band * i + band / 2, y: Hh - 6, 'text-anchor': 'middle', class: 'tick' });
    t.textContent = bucketLabel(r);
    svg.append(t);
  });

  // Stacked columns: 2px surface gap between segments, 4px rounded data-end on top only.
  rows.forEach((r, i) => {
    const cx = m.l + band * i + band / 2, x0 = cx - bw / 2;
    let acc = 0;
    const segs = ser.map((s) => ({ s, v: valueOf(r, s) })).filter((d) => d.v > 0);
    segs.forEach((d, j) => {
      const yb = y(acc), yt = y(acc + d.v);
      acc += d.v;
      const top = j === segs.length - 1;
      const h = Math.max(0, yb - yt - (j > 0 ? 2 : 0)); // gap above the previous segment
      const yTop = yb - (j > 0 ? 2 : 0) - h;
      if (h <= 0) return;
      const rad = top ? Math.min(4, h, bw / 2) : 0;
      const path = `M${x0},${yTop + h} V${yTop + rad} Q${x0},${yTop} ${x0 + rad},${yTop} H${x0 + bw - rad} Q${x0 + bw},${yTop} ${x0 + bw},${yTop + rad} V${yTop + h} Z`;
      svg.append(svgEl('path', { d: path, fill: d.s.color }));
    });
    // Hit target: the whole column band (bigger than the mark), focusable for keyboard.
    const hit = svgEl('rect', { x: m.l + band * i, y: m.t, width: band, height: ph, class: 'col-hit', tabindex: 0, 'data-i': i, 'aria-label': `${bucketLabel(r, true)}: ${money(totals[i])}` });
    const lift = svgEl('rect', { x: x0 - 2, y: m.t, width: bw + 4, height: ph, class: 'col-lift', rx: 4, 'fill-opacity': 0.06 });
    svg.append(hit, lift);
  });

  const tip = el('div', { class: 'tip', hidden: '' });
  box.replaceChildren(svg, tip);

  const show = (i, px, py) => {
    const r = rows[i];
    const kids = [el('div', { class: 't-head' }, bucketLabel(r, true))];
    for (const s of ser) {
      const v = valueOf(r, s);
      if (v <= 0) continue;
      kids.push(el('div', { class: 't-row' }, el('i', { style: `background:${s.color}` }), el('b', {}, money(v)), el('span', {}, s.name)));
    }
    kids.push(el('div', { class: 't-row t-total' }, el('b', {}, money(totals[i])), el('span', {}, 'total')));
    tip.replaceChildren(...kids);
    tip.hidden = false;
    const bw2 = box.clientWidth, tw = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(bw2 - tw, px - tw / 2))}px`;
    tip.style.top = `${Math.max(0, py - tip.offsetHeight - 12)}px`;
  };
  const hide = () => { tip.hidden = true; };
  const scale = () => box.clientWidth / W;
  svg.addEventListener('pointermove', (e) => {
    const t = e.target.closest('.col-hit');
    if (!t) return hide();
    const rect = box.getBoundingClientRect();
    show(+t.dataset.i, e.clientX - rect.left, (y(totals[+t.dataset.i]) * scale()));
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focusin', (e) => {
    const t = e.target.closest('.col-hit');
    if (!t) return;
    const i = +t.dataset.i;
    show(i, (m.l + band * i + band / 2) * scale(), y(totals[i]) * scale());
  });
  svg.addEventListener('focusout', hide);
}

function renderChartTable() {
  const ser = seriesList();
  const head = el('tr', {}, el('th', {}, H.group === 'month' ? 'Month' : 'Day'), ...ser.map((s) => el('th', {}, s.name)), el('th', {}, 'Total'));
  const body = H.rows.slice().reverse().map((r) => {
    const tot = ser.reduce((a, s) => a + valueOf(r, s), 0);
    return el('tr', {}, el('td', {}, bucketLabel(r, true)), ...ser.map((s) => el('td', {}, money(valueOf(r, s)))), el('td', {}, money(tot)));
  });
  $('chartTable').replaceChildren(el('table', { class: 'etable wide' }, head, ...body));
}

function renderBreakdown() {
  const ser = seriesList();
  const t = H.totals;
  const rows = H.series.map((s, i) => {
    const v = t.bySeries[s.id];
    const color = ser.find((x) => x.id === s.id)?.color || 'var(--series-other)';
    const energy = s.energy === 'gas' ? `${v.gasUnits.toFixed(v.gasUnits < 10 ? 2 : 0)} ${H.gas.unit}` : kwh(v.kWh);
    const share = t.cost > 0 ? `${Math.round((v.cost / t.cost) * 100)}%` : '—';
    // Energy rides under the name so Cost and Share stay visible on a phone.
    return el('tr', {},
      el('td', { class: 'eq-name' }, el('span', { class: 'swatch', style: `background:${color}` }), s.name,
        el('div', { class: 'eq-sub' }, energy)),
      el('td', {}, hours(v.seconds)), el('td', {}, money(v.cost)), el('td', {}, share));
  });
  if (!rows.length) return $('breakdown').replaceChildren(el('p', { class: 'empty' }, 'No equipment tracked yet. Add it in Energy → Settings.'));
  const head = el('tr', {}, ...['Equipment', 'Time', 'Cost', 'Share'].map((h) => el('th', {}, h)));
  const total = el('tr', {}, el('td', {}, el('b', {}, 'Total')), el('td', {}, ''), el('td', {}, el('b', {}, money(t.cost))), el('td', {}, ''));
  $('breakdown').replaceChildren(el('table', { class: 'etable' }, head, ...rows, total));
  $('breakdown').append(el('p', { class: 'hint' },
    `Electricity ${(H.rate * 100).toFixed(2)}¢/kWh · Gas $${H.gas.rate.toFixed(2)}/${H.gas.unit}. Measured pump power is exact; other equipment is run time × rating.`));
}

function renderSpeeds() {
  const sp = (H.bySpeed || []).filter((s) => s.seconds >= 60);
  $('speedCard').hidden = !sp.length;
  if (!sp.length) return;
  const head = el('tr', {}, ...['Speed', 'Time', 'Avg power', 'Cost'].map((h) => el('th', {}, h)));
  $('speeds').replaceChildren(el('table', { class: 'etable wide' }, head, ...sp.map((s) =>
    el('tr', {}, el('td', {}, `${s.rpm.toLocaleString()} RPM`), el('td', {}, hours(s.seconds)),
      el('td', {}, `${Math.round(s.avgWatts).toLocaleString()} W`), el('td', {}, money(s.cost))))));
}

async function footer() {
  try {
    const v = await (await fetch('/local/version')).json();
    const date = v.date ? ` · ${new Date(v.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
    $('footer').textContent = `Pool Remote v${v.version}${v.commit ? ` (${v.commit})` : ''}${date}`;
  } catch { /* optional */ }
}

$('ranges').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-range]');
  if (!b || b.dataset.range === range) return;
  range = b.dataset.range;
  try { localStorage.setItem(RANGE_KEY, range); } catch { /* per-viewer convenience only */ }
  load();
});
$('toggleTable').addEventListener('click', () => {
  const open = $('chartTable').hidden;
  $('chartTable').hidden = !open;
  $('toggleTable').textContent = open ? 'Hide table' : 'Show table';
  $('toggleTable').setAttribute('aria-expanded', String(open));
});
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => H && renderChart(), 150); });

load();
footer();
