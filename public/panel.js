'use strict';
// Panel settings: view and change the EasyTouch's own configuration through poolController.
// Every change is written to the EasyTouch, so each save asks for confirmation first.
// Uses globals from app.js: $, esc, api, toast, S, refresh, bodies.

const PANEL = { opts: null, pumpDraft: {}, editing: null };

const EGG_DEFAULT = 720; // 12 h: poolController's "no custom egg timer"
const EGG_DONT_STOP = 1620;

async function loadPanelOptions() {
  const get = (p) => api('GET', p).catch((err) => ({ _error: err.message }));
  const [circuits, features, pumps, names, general, dateTime, heaters] = await Promise.all([
    get('/config/options/circuits'), get('/config/options/features'), get('/config/options/pumps'),
    get('/config/options/customNames'), get('/config/options/general'), get('/config/options/dateTime'),
    get('/config/options/heaters'),
  ]);
  PANEL.opts = { circuits, features, pumps, names, general, dateTime, heaters };
  PANEL.pumpDraft = {};
}

async function openPanel() {
  $('panelBody').innerHTML = '<p class="empty">Reading settings from the EasyTouch…</p>';
  $('panelDialog').showModal();
  try {
    await loadPanelOptions();
    renderPanel();
  } catch (err) {
    $('panelBody').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

async function reloadPanel(msg) {
  // Re-read both the settings and the live state (names, panel clock) before redrawing.
  await Promise.all([loadPanelOptions(), refresh(true)]);
  renderPanel();
  if (msg) toast(msg);
}

function renderPanel() {
  $('panelBody').innerHTML = [
    pumpSection(), freezeSection(), circuitSection(), namesSection(), spaSection(), clockSection(), infoSection(),
  ].join('');
}

function confirmWrite(what) {
  return confirm(`Write this change to the EasyTouch?\n\n${what}`);
}

function sectionError(o) {
  return o && o._error ? `<p class="empty">Couldn't read: ${esc(o._error)}</p>` : '';
}

// ---------- Pump speeds ----------
function pumpTypeOf(p) {
  return (PANEL.opts.pumps.pumpTypes || []).find((t) => t.val === p.type) || {};
}

function speedPumps() {
  const o = PANEL.opts.pumps;
  return (o.pumps || []).filter((p) => {
    const t = pumpTypeOf(p);
    return p.isActive !== false && t.maxCircuits > 0 && t.hasAddress && typeof t.minSpeed === 'number';
  });
}

function pumpDraft(p) {
  if (!PANEL.pumpDraft[p.id]) {
    PANEL.pumpDraft[p.id] = (p.circuits || [])
      .filter((c) => c && c.circuit)
      .map((c) => ({ circuit: typeof c.circuit === 'object' ? c.circuit.id : c.circuit, speed: c.speed, units: c.units }));
  }
  return PANEL.pumpDraft[p.id];
}

function pumpSection() {
  const o = PANEL.opts.pumps;
  if (o._error) return `<section class="pset"><h3>Pump speeds</h3>${sectionError(o)}</section>`;
  const pumps = speedPumps();
  if (!pumps.length) return `<section class="pset"><h3>Pump speeds</h3><p class="empty">No IntelliFlo pump found in the EasyTouch setup.</p></section>`;
  const refs = (o.circuits || []).filter((c) => c.id > 0);
  return pumps.map((p) => {
    const t = pumpTypeOf(p);
    const slot = p.address ? p.address - 95 : null;
    const mismatch = slot !== null && p.id !== slot;
    const rows = pumpDraft(p);
    const step = t.speedStepSize || 10;
    // Spa with no speed of its own: the pump runs only while the heater fires ("Spa Heater"),
    // so it stops and starts with the heater. Checked against what's saved on the panel.
    const spa = refs.find((c) => /^spa$/i.test(c.name)) || refs.find((c) => c.id === 1);
    const savedIds = (p.circuits || []).map((c) => (c && typeof c.circuit === 'object' ? c.circuit.id : c?.circuit));
    const spaMissing = spa && !mismatch && !savedIds.includes(spa.id);
    const spaInDraft = spa && rows.some((r) => r.circuit === spa.id);
    const spaNote = spaMissing ? `<p class="warn-note"><b>Spa has no pump speed.</b> In Spa mode the pump then runs only while
      the heater is firing, so it stops when the spa reaches temperature and starts again when it cools.
      ${spaInDraft ? 'Tap <b>Save speeds</b> to send it to the panel.'
        : `Give Spa a speed to keep the pump running the whole time Spa is on.
      <button type="button" class="btn small" data-spa-speed="${p.id}:${spa.id}">Add Spa speed (2,500 RPM)</button>`}</p>` : '';
    const rowHtml = rows.map((r, i) => `
      <div class="speed-row" data-pump="${p.id}" data-row="${i}">
        <select data-k="circuit" ${mismatch ? 'disabled' : ''}>
          <option value="0" ${r.circuit ? '' : 'selected'} disabled>Circuit…</option>
          ${refs.map((c) => `<option value="${c.id}" ${c.id === r.circuit ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <div class="unit-input">
          <input type="number" data-k="speed" inputmode="numeric" min="${t.minSpeed}" max="${t.maxSpeed}" step="${step}"
            value="${r.speed ?? ''}" ${mismatch ? 'disabled' : ''}><span>RPM</span>
        </div>
        <button type="button" class="link-btn remove" data-speed-remove="${p.id}:${i}" ${mismatch ? 'disabled' : ''} aria-label="Remove">✕</button>
      </div>`).join('');
    return `
      <section class="pset">
        <h3>Pump speeds · ${esc(p.name || t.desc)}</h3>
        ${mismatch ? `<p class="warn-note">poolController has this pump as #${p.id} but it is EasyTouch slot ${slot}, so saving would
          write to the wrong slot. Run <code>node dev/patch-njspc-pump.js</code> on the Pi and restart poolController.</p>` : ''}
        ${spaNote}
        <p class="hint">The speed the pump runs at while each circuit is on (${t.minSpeed}–${t.maxSpeed} RPM). When several are on, the highest wins.</p>
        <div class="speed-list">${rowHtml || '<p class="empty">No speeds set.</p>'}</div>
        <div class="pset-actions">
          ${rows.length < t.maxCircuits && !mismatch ? `<button type="button" class="link-btn" data-speed-add="${p.id}">+ Add speed</button>` : '<span></span>'}
          <button type="button" class="btn primary" data-speed-save="${p.id}" ${mismatch ? 'disabled' : ''}>Save speeds</button>
        </div>
      </section>`;
  }).join('');
}

function readSpeedRows(pumpId) {
  document.querySelectorAll(`.speed-row[data-pump="${pumpId}"]`).forEach((row) => {
    const r = PANEL.pumpDraft[pumpId][parseInt(row.dataset.row, 10)];
    r.circuit = parseInt(row.querySelector('[data-k="circuit"]').value, 10) || 0;
    r.speed = parseInt(row.querySelector('[data-k="speed"]').value, 10);
  });
}

async function savePumpSpeeds(pumpId) {
  const p = speedPumps().find((x) => x.id === pumpId);
  const t = pumpTypeOf(p);
  readSpeedRows(pumpId);
  const rows = PANEL.pumpDraft[pumpId];
  const names = new Map((PANEL.opts.pumps.circuits || []).map((c) => [c.id, c.name]));
  const seen = new Set();
  for (const r of rows) {
    if (!r.circuit) return toast('Pick a circuit for every speed', true);
    if (seen.has(r.circuit)) return toast(`${names.get(r.circuit)} is listed twice`, true);
    seen.add(r.circuit);
    if (!(r.speed >= t.minSpeed && r.speed <= t.maxSpeed)) return toast(`Speeds must be ${t.minSpeed}–${t.maxSpeed} RPM`, true);
  }
  const summary = rows.map((r) => `${names.get(r.circuit) || 'Circuit ' + r.circuit}: ${r.speed} RPM`).join('\n') || '(no speeds)';
  if (!confirmWrite(`${p.name} speeds:\n${summary}`)) return;
  try {
    await api('PUT', '/config/pump', {
      id: p.id,
      circuits: rows.map((r) => ({ circuit: r.circuit, speed: r.speed, units: r.units ?? 0 })),
    });
    await reloadPanel('Pump speeds saved');
  } catch (err) { toast(err.message, true); }
}

// ---------- Circuits & features ----------
function functionList(kind) {
  const o = kind === 'feature' ? PANEL.opts.features : PANEL.opts.circuits;
  return o.functions || [];
}

function nameList() {
  return PANEL.opts.circuits.equipmentNames || [];
}

function eggText(c) {
  if (c.dontStop) return "Doesn't stop";
  const m = c.eggTimer || EGG_DEFAULT;
  if (m === EGG_DEFAULT) return null;
  const h = Math.floor(m / 60), min = m % 60;
  if (!min) return `${h} h`;
  return h ? `${h} h ${min} min` : `${min} min`;
}

function circuitRows(kind) {
  const o = kind === 'feature' ? PANEL.opts.features : PANEL.opts.circuits;
  const list = (kind === 'feature' ? o.features : o.circuits) || [];
  const fns = functionList(kind);
  return list.filter((c) => c && c.id && c.isActive !== false).map((c) => {
    const fn = fns.find((f) => f.val === c.type);
    const flags = [fn ? fn.desc : null, c.freeze ? 'Freeze protect' : null, eggText(c) ? `Egg timer ${eggText(c)}` : null].filter(Boolean);
    return `
      <button type="button" class="pset-row" data-edit-circuit="${kind}:${c.id}">
        <span class="name">${esc(c.name || `${kind} ${c.id}`)}</span>
        <span class="meta">${esc(flags.join(' · '))}</span>
      </button>`;
  }).join('');
}

function circuitSection() {
  const c = PANEL.opts.circuits, f = PANEL.opts.features;
  return `
    <section class="pset">
      <h3>Circuits</h3>
      ${sectionError(c) || `<div class="pset-list">${circuitRows('circuit')}</div>`}
      <h3 class="pset-sub">Features</h3>
      ${sectionError(f) || `<div class="pset-list">${circuitRows('feature') || '<p class="empty">No features.</p>'}</div>`}
    </section>`;
}

function isBodyFunction(type, kind) {
  const fn = functionList(kind).find((f) => f.val === type);
  return fn && (fn.name === 'pool' || fn.name === 'spa');
}

function openCircuitEditor(kind, id) {
  const o = kind === 'feature' ? PANEL.opts.features : PANEL.opts.circuits;
  const c = ((kind === 'feature' ? o.features : o.circuits) || []).find((x) => x.id === id);
  if (!c) return;
  PANEL.editing = { kind, id, original: c };
  const fns = functionList(kind);
  const locked = isBodyFunction(c.type, kind);
  const egg = c.dontStop ? 'dontstop' : String(c.eggTimer || EGG_DEFAULT);
  const eggOpts = [];
  for (let h = 1; h <= 11; h++) eggOpts.push([String(h * 60), `${h} hour${h > 1 ? 's' : ''}`]);
  eggOpts.push([String(EGG_DEFAULT), '12 hours (default)']);
  eggOpts.push(['dontstop', "Don't stop"]);
  if (!eggOpts.some(([v]) => v === egg)) eggOpts.unshift([egg, eggText(c) || egg]);

  $('circuitTitle').textContent = `${kind === 'feature' ? 'Feature' : 'Circuit'} ${id}: ${c.name}`;
  $('circName').innerHTML = nameList()
    .map((n) => `<option value="${n.val}" ${n.val === c.nameId ? 'selected' : ''}>${esc(n.desc || n.name)}</option>`).join('');
  $('circFunction').innerHTML = fns
    .map((f) => `<option value="${f.val}" ${f.val === c.type ? 'selected' : ''}>${esc(f.desc)}</option>`).join('');
  $('circFunction').disabled = locked;
  $('circFunctionNote').hidden = !locked;
  $('circFreeze').checked = !!c.freeze;
  $('circEgg').innerHTML = eggOpts.map(([v, l]) => `<option value="${v}" ${v === egg ? 'selected' : ''}>${esc(l)}</option>`).join('');
  $('circuitDialog').showModal();
}

async function saveCircuit() {
  const { kind, id, original } = PANEL.editing;
  const nameId = parseInt($('circName').value, 10);
  const type = parseInt($('circFunction').value, 10);
  const freeze = $('circFreeze').checked;
  const eggSel = $('circEgg').value;
  const dontStop = eggSel === 'dontstop';
  const eggTimer = dontStop ? EGG_DONT_STOP : parseInt(eggSel, 10);
  const fns = functionList(kind);
  const nameDesc = (nameList().find((n) => n.val === nameId) || {}).desc || nameId;
  const fnDesc = (fns.find((f) => f.val === type) || {}).desc || type;
  const notUsed = (fns.find((f) => f.val === type) || {}).name === 'notused';
  const changes = [
    `Name: ${nameDesc}`, `Function: ${fnDesc}`, `Freeze protection: ${freeze ? 'on' : 'off'}`,
    `Egg timer: ${dontStop ? "don't stop" : eggTimer === EGG_DEFAULT ? '12 hours (default)' : `${eggTimer / 60} h`}`,
  ].join('\n');
  if (notUsed && !confirm('"Not Used" removes this circuit from the EasyTouch. Continue?')) return;
  if (!confirmWrite(`${kind === 'feature' ? 'Feature' : 'Circuit'} ${id}:\n${changes}`)) return;
  try {
    await writeCircuit(kind, original, { nameId, type, freeze, eggTimer, dontStop });
    $('circuitDialog').close();
    await reloadPanel(`${nameDesc} saved`);
  } catch (err) { toast(err.message, true); }
}

// ---------- Custom names ----------
function namesSection() {
  const o = PANEL.opts.names;
  if (o._error) return `<section class="pset"><h3>Custom names</h3>${sectionError(o)}</section>`;
  // poolController numbers custom names from 0 (name #0 is list entry 200); show them 1-based.
  const list = [...(o.customNames || [])].sort((a, b) => a.id - b.id);
  // Factory placeholders ("USERNAME-01"…) mean the slot is unused: show them empty.
  const rows = list.map((n, i) => `<label class="name-row"><span>${i + 1}</span>
      <input type="text" maxlength="11" data-custom-name="${n.id}" value="${esc(customNameValue(n.name))}" placeholder="unused"></label>`);
  if (!rows.length) return `<section class="pset"><h3>Custom names</h3><p class="empty">This panel has no custom names.</p></section>`;
  const used = list.filter((n) => customNameValue(n.name)).length;
  return `
    <section class="pset">
      <details class="names-details" ${used ? 'open' : ''}>
        <summary><h3>Custom names</h3><span class="meta">${used ? `${used} in use` : 'all unused · optional'}</span></summary>
        <p class="hint">Circuit names can only be picked from the EasyTouch's built-in list (Pool, Spa, Air Blower…).
          To use a name that isn't on it, type it here (up to 11 characters), tap <b>Save names</b>, then open that
          circuit above and pick it under <b>Name</b>. Example: type "BUG ZAPPER", then set AUX 4's name to it.</p>
        <div class="names-grid">${rows.join('')}</div>
        <div class="pset-actions"><span></span><button type="button" class="btn primary" id="saveNames">Save names</button></div>
      </details>
    </section>`;
}

// "USERNAME-01" etc. are the EasyTouch's factory placeholders for unused slots.
function customNameValue(name) {
  return /^USERNAME-\d+$/i.test(name || '') ? '' : (name || '');
}

async function saveNames() {
  const o = PANEL.opts.names;
  const byId = new Map((o.customNames || []).map((n) => [n.id, customNameValue(n.name)]));
  const changed = [...document.querySelectorAll('[data-custom-name]')]
    .map((i) => ({ id: parseInt(i.dataset.customName, 10), name: i.value.trim() }))
    .filter((n) => n.name !== (byId.get(n.id) || '').trim());
  if (!changed.length) return toast('No changes');
  if (changed.some((n) => !n.name)) return toast("Names can't be blank (type a new name instead)", true);
  if (!confirmWrite(changed.map((n) => `Custom name ${n.id + 1}: ${n.name}`).join('\n'))) return;
  try {
    for (const n of changed) await api('PUT', '/config/customName', n);
    await reloadPanel('Names saved');
  } catch (err) { toast(err.message, true); }
}

// ---------- Spa ----------
// Always send every field: the EasyTouch command is built from the full set (e.g. a missing
// freeze flag would turn freeze protection off).
function writeCircuit(kind, c, changes) {
  const payload = {
    id: c.id, nameId: c.nameId, type: c.type, freeze: !!c.freeze,
    eggTimer: c.dontStop ? EGG_DONT_STOP : (c.eggTimer || EGG_DEFAULT), dontStop: !!c.dontStop,
    showInFeatures: typeof c.showInFeatures === 'boolean' ? c.showInFeatures : true,
    ...changes,
  };
  return api('PUT', kind === 'feature' ? '/config/feature' : '/config/circuit', payload);
}

// ---------- Freeze protection ----------
// The EasyTouch's freeze temperature is fixed (about 36°F air); what can be set is which
// circuits and features it runs. The cold alert is Pool Remote's own setting.
const FREEZE_START_F = 36;

function freezeItems() {
  const out = [];
  for (const kind of ['circuit', 'feature']) {
    const o = kind === 'feature' ? PANEL.opts.features : PANEL.opts.circuits;
    const fns = functionList(kind);
    for (const c of ((kind === 'feature' ? o.features : o.circuits) || [])) {
      if (!c || !c.id || c.isActive === false) continue;
      if ((fns.find((f) => f.val === c.type) || {}).name === 'notused') continue;
      out.push({ kind, c });
    }
  }
  return out;
}

function freezeSection() {
  const C = unit() === '°C';
  const start = C ? '2°C' : `${FREEZE_START_F}°F`;
  const air = S?.temps?.air;
  const running = !!S?.freeze;
  const items = freezeItems();
  const err = sectionError(PANEL.opts.circuits);
  const thr = typeof AL?.settings?.airThreshold === 'number' ? AL.settings.airThreshold : (C ? 3 : 38);
  return `
    <section class="pset" id="freezeSet">
      <h3>Freeze protection</h3>
      <div class="freeze-status ${running ? 'on' : ''}">
        <div><span class="fz-label">Starts at</span><b>${start} air</b></div>
        <div><span class="fz-label">Air now</span><b>${typeof air === 'number' ? Math.round(air) + '°' : '—'}</b></div>
        <div><span class="fz-label">Status</span><b>${running ? 'Running' : 'Standby'}</b></div>
      </div>
      <p class="hint">The EasyTouch sets this temperature itself; it can't be changed. When the air drops to it,
        the panel runs the equipment checked below (and the pump) until it warms up.</p>
      ${err || `<div class="pset-list freeze-list">${items.map(({ kind, c }) => `
        <label class="pset-row freeze-row">
          <span><span class="name">${esc(c.name || kind + ' ' + c.id)}</span>
            <span class="meta">${kind === 'feature' ? 'Feature' : 'Circuit'}${isBodyFunction(c.type, kind) ? ' · keeps water moving' : ''}</span></span>
          <input type="checkbox" class="switch" data-freeze="${kind}:${c.id}" ${c.freeze ? 'checked' : ''}
            aria-label="Freeze protection for ${esc(c.name || '')}">
        </label>`).join('')}</div>`}
      <h3 class="pset-sub">Cold alert</h3>
      <div class="freeze-alert">
        <label class="field"><span>Warn me when air drops to (${C ? '°C' : '°F'})</span>
          <input type="number" id="fzThreshold" step="1" inputmode="numeric" value="${thr}"></label>
        <button type="button" class="btn primary" id="fzThresholdSave">Save</button>
      </div>
      <p class="hint">Pool Remote's own warning (in the app${AL?.settings?.notify?.enabled ? ' and on your phone' : ''}), not written
        to the panel. A few degrees above ${start} gives you notice before freeze protection starts.
        ${AL?.settings?.notify?.enabled ? '' : 'Phone notifications: set them up in the Cold-weather alerts card.'}</p>
    </section>`;
}

async function saveFreezeFlag(input) {
  const [kind, idStr] = input.dataset.freeze.split(':');
  const id = parseInt(idStr, 10);
  const o = kind === 'feature' ? PANEL.opts.features : PANEL.opts.circuits;
  const c = ((kind === 'feature' ? o.features : o.circuits) || []).find((x) => x.id === id);
  const on = input.checked;
  if (!c || !confirmWrite(`${c.name}: freeze protection ${on ? 'on' : 'off'}`)) { input.checked = !on; return; }
  input.disabled = true;
  try {
    await writeCircuit(kind, c, { freeze: on });
    await reloadPanel(`${c.name}: freeze protection ${on ? 'on' : 'off'}`);
  } catch (err) { input.checked = !on; input.disabled = false; toast(err.message, true); }
}

async function saveFreezeThreshold() {
  try {
    const res = await fetch('/local/alerts/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ airThreshold: parseFloat($('fzThreshold').value) }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not save');
    AL = data;
    renderAlertsCard();
    renderColdBanner();
    toast(`Cold alert at ${data.settings.airThreshold}°`);
  } catch (err) { toast(err.message, true); }
}

function spaSection() {
  const spa = bodies().find((b) => (b.type?.name || '').toLowerCase() === 'spa');
  const g = PANEL.opts.general;
  if (!spa) return '';
  const manual = !!g?.pool?.options?.manualHeat;
  return `
    <section class="pset">
      <h3>Spa</h3>
      ${sectionError(g) || `
      <label class="check-row">
        <input type="checkbox" id="spaManualHeat" ${manual ? 'checked' : ''}>
        <span><b>Manual heat</b><br><small>When on, the heater runs only when you turn it on for the spa, not from schedules.</small></span>
      </label>`}
    </section>`;
}

async function saveSpaManualHeat(checkbox) {
  const spa = bodies().find((b) => (b.type?.name || '').toLowerCase() === 'spa');
  const on = checkbox.checked;
  if (!confirmWrite(`Spa manual heat: ${on ? 'on' : 'off'}`)) { checkbox.checked = !on; return; }
  try {
    await api('PUT', '/config/body', { id: spa.id, manualHeat: on });
    await reloadPanel(`Spa manual heat ${on ? 'on' : 'off'}`);
  } catch (err) { checkbox.checked = !on; toast(err.message, true); }
}

// ---------- Clock ----------
function panelTime() {
  // poolController sends e.g. "2026-11-21T17:08:15.000-0600". Safari needs "-06:00", so add the colon.
  const raw = typeof S?.time === 'string' ? S.time.replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : '';
  const t = raw ? new Date(raw) : null;
  return t && !isNaN(t) ? t : null;
}

function clockSection() {
  const g = PANEL.opts.general;
  const opts = g?.pool?.options || {};
  const t = panelTime();
  const now = new Date();
  const off = t ? Math.round((t - now) / 60000) : null;
  const fmt = (d) => d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const offText = off === null ? '' : Math.abs(off) <= 1 ? 'in sync with this phone' : `${Math.abs(off)} min ${off > 0 ? 'fast' : 'slow'}`;
  return `
    <section class="pset">
      <h3>Clock</h3>
      <p class="clock-line"><b>${t ? esc(fmt(t)) : 'Unknown'}</b> <span class="meta">${esc(offText)}</span></p>
      <label class="check-row"><input type="checkbox" id="clockAutoSync" ${opts.clockSource === 'server' ? 'checked' : ''}>
        <span><b>Keep in sync automatically</b><br><small>poolController corrects the panel clock from the Pi when it drifts more than 2 minutes.</small></span></label>
      <label class="check-row"><input type="checkbox" id="clockDst" ${opts.adjustDST ? 'checked' : ''}>
        <span><b>Adjust for daylight saving time</b></span></label>
      <div class="pset-actions"><span></span><button type="button" class="btn primary" id="saveClock">Set clock to this phone's time</button></div>
    </section>`;
}

async function saveClock() {
  const now = new Date();
  const dowList = PANEL.opts.dateTime?.dow || [];
  const dowEntry = dowList.find((d) => d.dow === now.getDay());
  const payload = {
    hour: now.getHours(),
    min: now.getMinutes(),
    date: now.getDate(),
    month: now.getMonth() + 1,
    year: now.getFullYear() % 100,
    dst: $('clockDst').checked,
    clockSource: $('clockAutoSync').checked ? 'server' : 'manual',
  };
  if (dowEntry) payload.dow = typeof dowEntry.bitval === 'number' ? dowEntry.bitval : dowEntry.val;
  const when = now.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (!confirmWrite(`Clock: ${when}\nDaylight saving: ${payload.dst ? 'auto' : 'off'}\nAuto-sync from Pi: ${payload.clockSource === 'server' ? 'on' : 'off'}`)) return;
  try {
    await api('PUT', '/config/dateTime', payload);
    await reloadPanel('Clock set');
  } catch (err) { toast(err.message, true); }
}

// ---------- Info (read-only) ----------
function infoSection() {
  const h = PANEL.opts.heaters;
  const types = h.heaterTypes || [];
  const heaters = (h.heaters || []).filter((x) => x && x.isActive !== false)
    .map((x) => (types.find((t) => t.val === x.type) || {}).desc || x.name).filter(Boolean);
  const rows = [
    ['Controller', S?.model || S?.equipment?.model || '—'],
    ['Heaters', heaters.length ? heaters.join(', ') : 'None'],
    ['poolController', S?.appVersion || '—'],
  ];
  return `
    <section class="pset">
      <h3>System</h3>
      <table class="etable">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    </section>`;
}

// ---------- Events ----------
$('openPanel').addEventListener('click', openPanel);
$('panelClose').addEventListener('click', () => $('panelDialog').close());

$('panelBody').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.speedAdd) {
    const id = parseInt(t.dataset.speedAdd, 10);
    readSpeedRows(id);
    const p = speedPumps().find((x) => x.id === id);
    PANEL.pumpDraft[id].push({ circuit: 0, speed: pumpTypeOf(p).minSpeed > 1000 ? pumpTypeOf(p).minSpeed : 1800, units: 0 });
    return renderPanel();
  }
  if (t.dataset.spaSpeed) {
    const [id, spaId] = t.dataset.spaSpeed.split(':').map(Number);
    readSpeedRows(id);
    PANEL.pumpDraft[id].push({ circuit: spaId, speed: 2500, units: 0 });
    renderPanel();
    document.querySelector(`.speed-row[data-pump="${id}"]:last-of-type [data-k="speed"]`)?.focus();
    return;
  }
  if (t.dataset.speedRemove) {
    const [id, i] = t.dataset.speedRemove.split(':').map(Number);
    readSpeedRows(id);
    PANEL.pumpDraft[id].splice(i, 1);
    return renderPanel();
  }
  if (t.dataset.speedSave) return savePumpSpeeds(parseInt(t.dataset.speedSave, 10));
  if (t.id === 'fzThresholdSave') return saveFreezeThreshold();
  if (t.dataset.editCircuit) {
    const [kind, id] = t.dataset.editCircuit.split(':');
    return openCircuitEditor(kind, parseInt(id, 10));
  }
  if (t.id === 'saveNames') return saveNames();
  if (t.id === 'saveClock') return saveClock();
});

$('panelBody').addEventListener('change', (e) => {
  if (e.target.id === 'spaManualHeat') saveSpaManualHeat(e.target);
  if (e.target.dataset.freeze) saveFreezeFlag(e.target);
});

$('circuitForm').addEventListener('submit', (e) => { e.preventDefault(); saveCircuit(); });
$('circCancel').addEventListener('click', () => $('circuitDialog').close());
