'use strict';

// ---------- Config ----------
const POLL_MS = 4000;
const SETPOINT_DEBOUNCE_MS = 900;
const HIDDEN_KEY = 'poolremote.hidden';

// ---------- State ----------
let S = null;                 // latest /state/all from poolController
let lastJson = '';
let lastOkAt = 0;
let fetching = false;
let failCount = 0;
const pending = new Set();    // keys of controls with a request in flight
const heatModes = {};         // bodyId -> [{val,name,desc}]
const setpointDraft = {};     // bodyId -> number (user is adjusting)
const setpointTimers = {};
let schedOpts = null;         // /config/options/schedules
const editMode = { lights: false, aux: false };
let hidden = loadHidden();

const $ = (id) => document.getElementById(id);

// ---------- Helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loadHidden() {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '{}');
    return { lights: v.lights || [], aux: v.aux || [] };
  } catch {
    return { lights: [], aux: [] };
  }
}

function saveHidden() {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)); } catch { /* storage unavailable */ }
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 5000 : 2500);
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

function unit() {
  const n = S?.temps?.units?.name;
  return n === 'C' ? '°C' : '°F';
}

function fmtTemp(v) {
  return typeof v === 'number' && !Number.isNaN(v) ? Math.round(v) : '--';
}

function minutesToHHMM(m) {
  m = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function hhmmToMinutes(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function fmtClock(m) {
  m = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${ampm}`;
}

function bodies() {
  return [...(S?.temps?.bodies || [])].sort((a, b) => a.id - b.id);
}

function bodyCircuitIds() {
  return new Set(bodies().map((b) => b.circuit));
}

function isBusy(key) { return pending.has(key); }

async function withPending(key, fn) {
  if (pending.has(key)) return;
  pending.add(key);
  render(true);
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    pending.delete(key);
    await refresh(true);
    energySoon();
  }
}

// After switching equipment: read energy now, then again as pumps ramp up and the
// controller reports the change (it can take a few seconds).
let energyTimers = [];
function energySoon() {
  energyTimers.forEach(clearTimeout);
  loadEnergy('now');
  energyTimers = [4000, 10000].map((ms) => setTimeout(() => { refresh(true); loadEnergy('now'); }, ms));
}

// ---------- Data ----------
async function refresh(force = false) {
  if (fetching && !force) return;
  fetching = true;
  try {
    const data = await api('GET', '/state/all');
    S = data;
    lastOkAt = Date.now();
    failCount = 0;
    const json = JSON.stringify(data);
    if (force || json !== lastJson) {
      lastJson = json;
      render();
    } else {
      renderStatus();
    }
    loadHeatModes();
  } catch (err) {
    failCount++;
    renderStatus(err.message);
  } finally {
    fetching = false;
  }
}

async function loadHeatModes() {
  for (const b of bodies()) {
    if (heatModes[b.id]) continue;
    heatModes[b.id] = [];
    try {
      const modes = await api('GET', `/config/body/${b.id}/heatModes`);
      heatModes[b.id] = Array.isArray(modes) && modes.length ? modes : null;
    } catch {
      heatModes[b.id] = null;
    }
    render(true);
  }
}

// ---------- Rendering ----------
function render() {
  if (!S) return;
  renderStatus();
  renderHero();
  renderMode();
  renderHeat();
  renderTiles('lights');
  renderTiles('aux');
  renderPumps();
  renderSchedules();
  renderFooter();
}

function renderStatus(errMsg) {
  const dot = $('statusDot');
  const text = $('statusText');
  const stale = Date.now() - lastOkAt > POLL_MS * 3;
  if (!S || (errMsg && stale)) {
    dot.className = 'dot bad';
    text.textContent = errMsg ? 'Not connected to Pi' : 'Connecting…';
    return;
  }
  $('poolName').textContent = S.alias || 'Pool';
  const type = (S.controllerType || '').toLowerCase();
  const statusName = S.status?.name || '';
  if (type === 'nixie' || type === 'unknown' || !type) {
    dot.className = 'dot warn';
    text.textContent = 'Virtual mode — not linked to EasyTouch';
  } else if (statusName && statusName !== 'ready') {
    dot.className = 'dot warn';
    const pct = typeof S.status.percent === 'number' && S.status.percent > 0 ? ` ${S.status.percent}%` : '';
    text.textContent = (S.status.desc || statusName) + pct;
  } else {
    dot.className = 'dot ok';
    text.textContent = S.model || S.equipment?.model || 'Connected';
  }

}

function renderHero() {
  const list = bodies();
  const active = list.find((b) => b.isOn) || list[0];
  $('heroUnit').textContent = unit();
  const air = S.temps?.air;
  $('heroAir').hidden = typeof air !== 'number';
  $('heroAirTemp').textContent = fmtTemp(air);
  if (!active) {
    $('heroLabel').textContent = 'Water';
    $('heroTemp').textContent = '--';
    $('heroSub').innerHTML = '&nbsp;';
    renderNow();
    return;
  }
  const anyOn = list.some((b) => b.isOn);
  $('heroLabel').textContent = `${active.name || 'Pool'} water`;
  $('heroTemp').textContent = fmtTemp(active.temp);
  const parts = [];
  if (isHeating(active)) parts.push(`<span class="badge heating">Heating</span>`);
  const sp = setpointDraft[active.id] ?? active.setPoint;
  const modeName = active.heatMode?.name;
  if (modeName && modeName !== 'off' && typeof sp === 'number') parts.push(`<span>Heat to ${sp}°</span>`);
  if (!anyOn) parts.push('<span class="badge">Pump off · last reading</span>');
  $('heroSub').innerHTML = parts.join('') || '&nbsp;';
  renderNow();
}

function isHeating(b) {
  return !!(b.heatStatus && b.heatStatus.name && b.heatStatus.name !== 'off');
}

// Is an Energy-settings equipment item running right now? From live state, so it's instant.
function equipIsOn(e) {
  const src = e.source || {};
  if (src.kind === 'heater') return bodies().some(isHeating);
  const list = src.kind === 'feature' ? S.features : S.circuits;
  const item = (list || []).find((x) => x.id === src.id);
  return item ? !!item.isOn : !!E?.live?.on?.[e.id];
}

function speedPumpsNow() {
  return (S.pumps || []).filter((p) => p && p.id && ['vs', 'vssvrs', 'vsf', 'vf'].includes((p.type?.name || '').toLowerCase()));
}

// Today's running schedule, or the next one that starts later today.
function scheduleNow() {
  const list = (S.schedules || []).filter((x) => x && x.id && !x.disabled && x.circuit);
  const nameOf = (x) => x.circuit?.name || `Circuit ${x.circuit?.id ?? x.circuit}`;
  const running = list.filter((x) => x.isOn);
  if (running.length) {
    return running.map((x) => `${nameOf(x)} until ${fmtClock(x.endTime || 0)}`).join(', ');
  }
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const today = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()];
  const next = list
    .filter((x) => (x.scheduleDays?.days || []).some((d) => (d.name || '').toLowerCase() === today) && (x.startTime || 0) > mins)
    .sort((a, b) => a.startTime - b.startTime)[0];
  return next ? `Next: ${nameOf(next)} at ${fmtClock(next.startTime)}` : 'No more schedules today';
}

function renderNow() {
  const rows = [];
  const list = bodies();
  const on = list.find((b) => b.isOn);
  rows.push(['Mode', on ? `${on.name} mode` : 'Everything off']);

  // Pumps: the IntelliFlo (measured) plus any equipment marked Pump.
  const pumpBits = [];
  for (const p of speedPumpsNow()) {
    pumpBits.push(p.rpm > 0 ? `${p.name || 'Pump'} ${p.rpm.toLocaleString()} RPM · ${Math.round(p.watts || 0).toLocaleString()} W` : `${p.name || 'Pump'} off`);
  }
  if (!speedPumpsNow().length) pumpBits.push(on ? 'Filter pump running' : 'Filter pump off');
  for (const e of (E?.equipment || []).filter((x) => x.category === 'pump')) {
    if (equipIsOn(e)) pumpBits.push(`${e.name} running`);
  }
  rows.push(['Pumps', pumpBits.join(' · ')]);

  const heating = list.filter(isHeating);
  const heatOn = list.filter((b) => b.heatMode?.name && b.heatMode.name !== 'off');
  // Heat set "on" for a body that isn't running is normal: it heats when that body runs.
  const heatText = (b) => (b.isOn ? `${b.name} at temperature (${b.setPoint}°)` : `Ready for ${b.name} (heats to ${b.setPoint}° when it runs)`);
  rows.push(['Heater', heating.length
    ? heating.map((b) => `Heating ${b.name} to ${b.setPoint}°`).join(', ')
    : heatOn.length ? heatOn.map(heatText).join(', ') : 'Off']);

  const bodyIds = bodyCircuitIds();
  const onNames = []
    .concat((S.circuits || []).filter((c) => c.isOn && !bodyIds.has(c.id)).map((c) => c.name))
    .concat((S.features || []).filter((f) => f.isOn).map((f) => f.name));
  rows.push(['Also on', onNames.length ? onNames.join(', ') : 'Nothing else']);

  rows.push(['Schedule', scheduleNow()]);
  if (S.freeze) rows.push(['Freeze', 'Freeze protection is running']);

  // What it's all costing right now: measured pump power plus equipment that's on.
  if (E) {
    let perHour = (E.live?.watts || 0) / 1000 * E.rate;
    for (const e of E.equipment || []) if (equipIsOn(e)) perHour += e.perHour?.cost || 0;
    rows.push(['Cost now', perHour > 0 ? `${money(perHour)}/hr` : '$0.00/hr']);
  }
  $('heroNow').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

function renderMode() {
  const list = bodies();
  const activeIds = list.filter((b) => b.isOn).map((b) => b.id);
  const busy = isBusy('mode');
  const btns = [`<button role="radio" data-mode="off" aria-checked="${activeIds.length === 0}" ${busy ? 'disabled' : ''}>Off</button>`];
  for (const b of list) {
    const isSpa = (b.type?.name || '').toLowerCase() === 'spa' || /spa/i.test(b.name || '');
    btns.push(`<button role="radio" class="${isSpa ? 'spa' : ''}" data-mode="${b.id}" aria-checked="${activeIds.includes(b.id)}" ${busy ? 'disabled' : ''}>${esc(b.name || 'Body ' + b.id)}</button>`);
  }
  $('modeButtons').innerHTML = btns.join('');
  const on = list.find((b) => b.isOn);
  $('modeHint').textContent = busy
    ? 'Switching… valves and pump may take a minute.'
    : on ? `Pump running in ${on.name} mode.` : 'Pump is off.';
}

function renderHeat() {
  const list = bodies();
  $('heatSection').hidden = list.length === 0;
  const u = unit();
  $('heatList').innerHTML = list.map((b) => {
    const sp = setpointDraft[b.id] ?? b.setPoint;
    const heating = b.heatStatus && b.heatStatus.name && b.heatStatus.name !== 'off';
    const modes = heatModes[b.id]?.length ? heatModes[b.id] : [{ name: 'off', desc: 'Off' }, { name: 'heater', desc: 'Heater' }];
    const busyMode = isBusy('heatmode' + b.id);
    const chips = modes.map((m) => {
      const pressed = (b.heatMode?.name || 'off') === m.name;
      return `<button class="chip ${m.name === 'off' ? 'off' : ''} ${busyMode ? 'busy' : ''}" data-heatmode="${esc(m.name)}" data-body="${b.id}" aria-pressed="${pressed}">${esc(m.desc || m.name)}</button>`;
    }).join('');
    const status = heating ? 'Heating now' : (b.heatStatus?.desc && b.heatStatus.name !== 'off' ? b.heatStatus.desc : 'Not heating');
    return `
      <div class="heat-row">
        <div class="heat-top">
          <div>
            <div class="heat-name">${esc(b.name)}</div>
            <div class="heat-status ${heating ? 'on' : ''}">${esc(status)}</div>
          </div>
          <div class="stepper ${isBusy('setpoint' + b.id) ? 'busy' : ''}">
            <button data-setpoint="-1" data-body="${b.id}" aria-label="Lower ${esc(b.name)} setpoint">−</button>
            <div class="value">${typeof sp === 'number' ? sp : '--'}<small>${u}</small></div>
            <button data-setpoint="1" data-body="${b.id}" aria-label="Raise ${esc(b.name)} setpoint">+</button>
          </div>
        </div>
        <div class="chips">${chips}</div>
      </div>`;
  }).join('');
}

function tileItems(group) {
  const bodyIds = bodyCircuitIds();
  const items = [];
  for (const c of S.circuits || []) {
    if (bodyIds.has(c.id)) continue;
    const typeName = (c.type?.name || '').toLowerCase();
    if (typeName === 'notused') continue;
    const isLight = !!c.type?.isLight;
    if ((group === 'lights') !== isLight) continue;
    items.push({ kind: 'circuit', id: c.id, name: c.name || `Circuit ${c.id}`, isOn: !!c.isOn });
  }
  if (group === 'aux') {
    for (const f of S.features || []) {
      items.push({ kind: 'feature', id: f.id, name: f.name || `Feature ${f.id}`, isOn: !!f.isOn });
    }
  }
  return items;
}

function renderTiles(group) {
  const items = tileItems(group);
  const editing = editMode[group];
  const hiddenKeys = new Set(hidden[group]);
  const visible = editing ? items : items.filter((i) => !hiddenKeys.has(`${i.kind}:${i.id}`));
  const section = $(group === 'lights' ? 'lightsSection' : 'auxSection');
  const box = $(group === 'lights' ? 'lightTiles' : 'auxTiles');
  section.hidden = items.length === 0;
  section.querySelector('[data-edit]').textContent = editing ? 'Done' : 'Edit';
  if (visible.length === 0) {
    box.innerHTML = `<p class="empty">All hidden. Tap Edit to show some.</p>`;
    return;
  }
  box.innerHTML = visible.map((i) => {
    const key = `${i.kind}:${i.id}`;
    const isHidden = hiddenKeys.has(key);
    const stateText = editing ? '' : (i.isOn ? 'On' : 'Off');
    return `
      <button class="tile ${group === 'lights' ? 'light' : ''} ${isHidden && editing ? 'hidden-item' : ''} ${isBusy(key) ? 'busy' : ''}"
        data-group="${group}" data-kind="${i.kind}" data-id="${i.id}" data-on="${i.isOn}"
        aria-pressed="${editing ? 'false' : i.isOn}">
        ${editing ? `<span class="eye">${isHidden ? 'Hidden' : 'Shown'}</span>` : ''}
        <span class="name">${esc(i.name)}</span>
        <span class="state">${stateText}</span>
      </button>`;
  }).join('');
}

function renderPumps() {
  // Variable-speed pumps (IntelliFlo VS/VSF/VF) talk to the controller. Decide by type, not by
  // current readings: poolController leaves out RPM/watts while the pump is off.
  const SPEED_TYPES = ['vs', 'vssvrs', 'vsf', 'vf'];
  const isSpeedPump = (p) => SPEED_TYPES.includes((p.type?.name || '').toLowerCase())
    || typeof p.rpm === 'number' || typeof p.watts === 'number';
  let pumps = (S.pumps || []).filter((p) => p && p.id);
  // With an IntelliFlo present, hide relay-only entries like the EasyTouch's "Two Speed"
  // setting: they don't add information and look like a second pump.
  if (pumps.some(isSpeedPump)) pumps = pumps.filter(isSpeedPump);
  const anyBodyOn = bodies().some((b) => b.isOn);
  const extra = equipmentPumpRows();
  if (pumps.length === 0) {
    const on = bodies().find((b) => b.isOn);
    $('pumpList').innerHTML = extra + `
      <div class="pump">
        <div>
          <div class="name">Filter pump</div>
          <div class="meta">${on ? `Running for ${esc(on.name)}` : 'Starts with Pool or Spa mode and schedules'}</div>
        </div>
        <span class="pill ${anyBodyOn ? 'on' : ''}">${anyBodyOn ? 'Running' : 'Off'}</span>
      </div>`;
    return;
  }
  $('pumpList').innerHTML = pumps.map((p) => {
    const hasSpeed = typeof p.rpm === 'number' || typeof p.watts === 'number';
    const running = hasSpeed ? (p.rpm > 0 || p.watts > 0) : (p.relay > 0 || anyBodyOn);
    const meta = [];
    if (p.rpm > 0) meta.push(`${p.rpm} rpm`);
    if (p.flow > 0) meta.push(`${p.flow} gpm`);
    if (p.watts > 0) meta.push(`${p.watts} W`);
    if (!meta.length && p.type?.desc) meta.push(p.type.desc);
    return `
      <div class="pump">
        <div>
          <div class="name">${esc(p.name || 'Pump ' + p.id)}</div>
          <div class="meta">${esc(meta.join(' · '))}</div>
        </div>
        <span class="pill ${running ? 'on' : ''}">${running ? 'Running' : 'Off'}</span>
      </div>`;
  }).join('') + extra;
}

// Equipment marked "Pump" in Energy settings (e.g. a single-speed water feature pump that the
// controller only switches on and off). Running state comes straight from its circuit, so it
// updates as fast as the rest of the screen; power is the rating entered in settings.
function equipmentPumpRows() {
  const items = (E?.equipment || []).filter((e) => e.category === 'pump');
  return items.map((e) => {
    const src = e.source || {};
    const list = src.kind === 'feature' ? S.features : S.circuits;
    const item = (list || []).find((x) => x.id === src.id);
    const running = item ? !!item.isOn : !!E.live?.on?.[e.id];
    const rating = e.energy === 'gas' ? `${Math.round(e.btu / 1000)}k BTU/hr` : `${Math.round(e.watts).toLocaleString()} W (rated)`;
    const meta = running ? `${rating} · ${money(e.perHour.cost)}/hr` : `${rating} · with ${item?.name || 'its circuit'}`;
    return `
      <div class="pump">
        <div>
          <div class="name">${esc(e.name)}</div>
          <div class="meta">${esc(meta)}</div>
        </div>
        <span class="pill ${running ? 'on' : ''}">${running ? 'Running' : 'Off'}</span>
      </div>`;
  }).join('');
}

function scheduleTimeText(s) {
  const t = (type, minutes) => {
    const n = (type?.name || '').toLowerCase();
    if (n === 'sunrise') return 'Sunrise';
    if (n === 'sunset') return 'Sunset';
    return fmtClock(minutes || 0);
  };
  if ((s.scheduleType?.name || '') === 'runonce') return `${t(s.startTimeType, s.startTime)} · once`;
  return `${t(s.startTimeType, s.startTime)} – ${t(s.endTimeType, s.endTime)}`;
}

function daysText(s) {
  const days = s.scheduleDays?.days || [];
  const names = days.map((d) => (d.name || '').toLowerCase());
  const set = new Set(names);
  if (set.size === 7) return 'Every day';
  const wk = ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (set.size === 5 && wk.every((d) => set.has(d))) return 'Weekdays';
  if (set.size === 2 && set.has('sat') && set.has('sun')) return 'Weekends';
  if (set.size === 0) return 'No days';
  const order = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return order.filter((d) => set.has(d)).map((d) => d[0].toUpperCase() + d.slice(1)).join(', ');
}

function renderSchedules() {
  const list = (S.schedules || []).filter((s) => s && s.id && s.circuit && (s.circuit.id || typeof s.circuit === 'number'));
  if (list.length === 0) {
    $('scheduleList').innerHTML = '<p class="empty">No schedules yet.</p>';
    return;
  }
  list.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  $('scheduleList').innerHTML = list.map((s) => {
    const name = s.circuit?.name || `Circuit ${s.circuit?.id ?? s.circuit}`;
    const extra = s.disabled ? ' · paused' : s.isOn ? ' · running now' : '';
    return `
      <button class="schedule ${s.isOn ? 'running' : ''}" data-schedule="${s.id}">
        <span class="name">${esc(name)}</span>
        <span class="time">${esc(scheduleTimeText(s))}</span>
        <span class="days-text">${esc(daysText(s) + extra)}</span>
      </button>`;
  }).join('');
}

function renderFooter() {
  const time = new Date(lastOkAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const ver = S.appVersion ? ` · poolController ${S.appVersion}` : '';
  $('footer').textContent = `${versionText()} · Updated ${time}${ver}`;
}

// ---------- Actions ----------
async function setMode(target) {
  await withPending('mode', async () => {
    const list = bodies();
    if (target === 'off') {
      for (const b of list.filter((x) => x.isOn)) {
        await api('PUT', '/state/circuit/setState', { id: b.circuit, isOn: false });
      }
      return;
    }
    const body = list.find((b) => String(b.id) === String(target));
    if (!body || body.isOn) return;
    // Turn the new mode on first so the pump doesn't stop between modes.
    await api('PUT', '/state/circuit/setState', { id: body.circuit, isOn: true });
    const fresh = await api('GET', '/state/temps');
    for (const other of (fresh.bodies || [])) {
      if (other.id !== body.id && other.isOn) {
        await api('PUT', '/state/circuit/setState', { id: other.circuit, isOn: false });
      }
    }
  });
}

function bumpSetpoint(bodyId, delta) {
  const b = bodies().find((x) => x.id === bodyId);
  if (!b) return;
  const [min, max] = unit() === '°C' ? [4, 40] : [40, 104];
  const current = setpointDraft[bodyId] ?? b.setPoint ?? (unit() === '°C' ? 27 : 80);
  setpointDraft[bodyId] = Math.min(max, Math.max(min, current + delta));
  render();
  clearTimeout(setpointTimers[bodyId]);
  setpointTimers[bodyId] = setTimeout(async () => {
    const value = setpointDraft[bodyId];
    await withPending('setpoint' + bodyId, async () => {
      await api('PUT', '/state/body/setPoint', { id: bodyId, setPoint: value });
      toast(`${b.name} set to ${value}${unit()}`);
    });
    delete setpointDraft[bodyId];
    render();
  }, SETPOINT_DEBOUNCE_MS);
}

async function setHeatMode(bodyId, mode) {
  await withPending('heatmode' + bodyId, async () => {
    await api('PUT', '/state/body/heatMode', { id: bodyId, mode });
  });
}

async function toggleItem(kind, id, isOn) {
  const key = `${kind}:${id}`;
  await withPending(key, async () => {
    await api('PUT', `/state/${kind}/setState`, { id, isOn: !isOn });
  });
}

// ---------- Schedule editor ----------
let editingSchedule = null;
let draftDays = 0;

function dayDefs() {
  const defs = (schedOpts?.scheduleDays || []).map((d) => ({
    name: (d.name || '').toLowerCase(),
    bit: typeof d.bitval === 'number' ? d.bitval : 1 << (d.val - 1),
    dow: typeof d.dow === 'number' ? d.dow : 0,
  }));
  return defs.sort((a, b) => a.dow - b.dow);
}

function renderDays() {
  $('schedDays').innerHTML = dayDefs().map((d) =>
    `<button type="button" data-bit="${d.bit}" aria-pressed="${(draftDays & d.bit) !== 0}" aria-label="${d.name}">${d.name.slice(0, 2).replace(/^./, (c) => c.toUpperCase())}</button>`
  ).join('');
}

async function openSchedule(id) {
  try {
    schedOpts = await api('GET', '/config/options/schedules');
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const s = id ? (S.schedules || []).find((x) => x.id === id) : null;
  editingSchedule = s;
  const circuits = (schedOpts.circuits || []).filter((c) => c.id > 0);
  const currentCircuit = s ? (s.circuit?.id ?? s.circuit) : (bodies()[0]?.circuit ?? circuits[0]?.id);
  $('schedCircuit').innerHTML = circuits.map((c) =>
    `<option value="${c.id}" ${c.id === currentCircuit ? 'selected' : ''}>${esc(c.name)}</option>`
  ).join('');
  $('schedStart').value = minutesToHHMM(s ? s.startTime : 8 * 60);
  $('schedEnd').value = minutesToHHMM(s ? s.endTime : 16 * 60);
  draftDays = s ? (s.scheduleDays?.val ?? 0) : dayDefs().reduce((acc, d) => acc | d.bit, 0);
  renderDays();

  const isRunOnce = s && (s.scheduleType?.name || '') === 'runonce';
  const sunTimed = s && ['sunrise', 'sunset'].some((n) =>
    (s.startTimeType?.name || '') === n || (s.endTimeType?.name || '') === n);
  const note = $('schedNote');
  note.hidden = !(isRunOnce || sunTimed);
  note.textContent = isRunOnce
    ? 'This is a run-once schedule. You can delete it here; edit it in dashPanel.'
    : sunTimed ? 'This schedule uses sunrise/sunset. Saving here changes it to fixed clock times.' : '';
  $('schedSave').disabled = !!isRunOnce;
  $('schedDelete').hidden = !s;
  $('scheduleTitle').textContent = s ? 'Edit schedule' : 'New schedule';
  $('scheduleDialog').showModal();
}

async function saveSchedule() {
  if (draftDays === 0) { toast('Pick at least one day', true); return; }
  const repeat = (schedOpts.scheduleTypes || []).find((t) => t.name === 'repeat');
  const manual = (schedOpts.scheduleTimeTypes || []).find((t) => t.name === 'manual');
  const payload = {
    circuit: parseInt($('schedCircuit').value, 10),
    startTime: hhmmToMinutes($('schedStart').value),
    endTime: hhmmToMinutes($('schedEnd').value),
    scheduleDays: draftDays,
    scheduleType: repeat ? repeat.val : 0,
    startTimeType: manual ? manual.val : 0,
    endTimeType: manual ? manual.val : 0,
  };
  if (editingSchedule) payload.id = editingSchedule.id;
  $('schedSave').disabled = true;
  try {
    await api('PUT', '/config/schedule', payload);
    $('scheduleDialog').close();
    toast('Schedule saved');
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('schedSave').disabled = false;
    refresh(true);
  }
}

async function deleteSchedule() {
  if (!editingSchedule) return;
  if (!confirm('Delete this schedule?')) return;
  try {
    await api('DELETE', '/config/schedule', { id: editingSchedule.id });
    $('scheduleDialog').close();
    toast('Schedule deleted');
  } catch (err) {
    toast(err.message, true);
  } finally {
    refresh(true);
  }
}

// ---------- Energy ----------
let E = null; // latest /local/energy report

// fresh: false = cached report, true = reading if older than 2 s, 'now' = new reading right away.
async function loadEnergy(fresh = false) {
  try {
    const res = await fetch(fresh === 'now' ? '/local/energy?fresh=now' : fresh ? '/local/energy?fresh=1' : '/local/energy');
    if (!res.ok) throw new Error(`Energy data unavailable (${res.status})`);
    E = await res.json();
    renderEnergy();
    if (S) { renderPumps(); renderNow(); }
  } catch (err) {
    $('energyBody').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);
const kwh = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} kWh`;
const hours = (s) => {
  const h = s / 3600;
  return h < 1 ? `${Math.round(s / 60)} min` : `${h.toFixed(1)} h`;
};

function fmtGas(units) {
  const u = E?.gas?.unit || 'CCF';
  return `${units < 10 ? units.toFixed(2) : Math.round(units)} ${u}`;
}

function itemEnergyText(e, it) {
  return e.energy === 'gas' ? fmtGas(it.gasUnits) : kwh(it.kWh);
}

function renderEnergy() {
  if (!E) return;
  const box = $('energyBody');
  const live = E.live || {};
  const g = E.gas || {};
  if (!live.ok && !E.since) {
    box.innerHTML = `<p class="empty">Waiting for poolController…</p>`;
    return;
  }

  const rows = [];
  if (live.pumps) {
    rows.push(`<div class="live-row"><span class="live-name">Pump</span>
      <span class="live-val">${live.watts > 0 ? `${Math.round(live.watts).toLocaleString()} W` : 'Off'}</span>
      <span class="meta">${live.watts > 0 ? `${live.rpm ? live.rpm.toLocaleString() + ' RPM · ' : ''}${money(live.watts / 1000 * E.rate)}/hr` : 'measured'}</span></div>`);
  }
  for (const e of E.equipment || []) {
    const on = !!live.on?.[e.id];
    const word = on ? (e.energy === 'gas' ? 'Firing' : 'On') : 'Off';
    const rating = e.energy === 'gas' ? `${Math.round(e.btu / 1000)}k BTU` : `${Math.round(e.watts).toLocaleString()} W`;
    rows.push(`<div class="live-row ${on ? 'firing' : ''}"><span class="live-name">${esc(e.name)}</span>
      <span class="live-val">${word}</span>
      <span class="meta">${on ? `${money(e.perHour.cost)}/hr` : rating}</span></div>`);
  }
  const pumpNote = live.pumps ? '' : `<p class="hint">The pump isn't reporting power. Connect the IntelliFlo to the
    EasyTouch, or add it in Settings with its watts.</p>`;

  const stat = (label, s, extra = '') => `
    <div class="stat">
      <div class="label">${label}</div>
      <div class="cost">${money(s.totalCost)}</div>
      <div class="kwh">Elec ${money(s.elecCost)}<br>Gas ${money(s.gasCost)}${extra}</div>
    </div>`;
  const proj = E.month.projected;
  const projText = proj ? `<br>≈ $${Math.round(proj.totalCost)}/mo` : '';

  // Per-item breakdown over the last 30 days.
  const L = E.last30;
  const itemRows = [];
  if (L.pumpKWh > 0) itemRows.push(`<tr><td>Pump (measured)</td><td>${hours(L.runSeconds)}</td><td>${kwh(L.pumpKWh)}</td><td>${money(L.pumpCost)}</td></tr>`);
  for (const e of E.equipment || []) {
    const it = L.items[e.id];
    if (!it || it.seconds < 60) continue;
    itemRows.push(`<tr><td>${esc(e.name)}</td><td>${hours(it.seconds)}</td><td>${itemEnergyText(e, it)}</td><td>${money(it.cost)}</td></tr>`);
  }
  const itemTable = itemRows.length ? `
    <div class="subhead">By equipment · last 30 days</div>
    <table class="etable">
      <tr><th>Equipment</th><th>Time</th><th>Energy</th><th>Cost</th></tr>
      ${itemRows.join('')}
    </table>` : '';

  const speeds = (E.bySpeed || []).filter((s) => s.seconds >= 60).slice(0, 6);
  const speedTable = speeds.length ? `
    <div class="subhead">Pump by speed · last 30 days</div>
    <table class="etable">
      <tr><th>Speed</th><th>Time</th><th>Avg power</th><th>Cost</th></tr>
      ${speeds.map((s) => `<tr><td>${s.rpm.toLocaleString()} RPM</td><td>${hours(s.seconds)}</td><td>${Math.round(s.avgWatts).toLocaleString()} W</td><td>${money(s.cost)}</td></tr>`).join('')}
    </table>` : '';

  const days = (E.days || []).slice(0, 7);
  const dayTable = `
    <div class="subhead">Last 7 days</div>
    <table class="etable">
      <tr><th>Day</th><th>Electric</th><th>Gas</th><th>Total</th></tr>
      ${days.map((d, i) => {
        const label = i === 0 ? 'Today' : new Date(d.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        return `<tr><td>${label}</td><td>${money(d.elecCost)}</td><td>${d.gasCost ? money(d.gasCost) : '—'}</td><td>${money(d.totalCost)}</td></tr>`;
      }).join('')}
    </table>`;

  box.innerHTML = `
    <div class="live">${rows.join('')}</div>
    ${pumpNote}
    <div class="stats">
      ${stat('Today', E.today)}
      ${stat('Last 7 days', E.week)}
      ${stat('This month', E.month, projText)}
    </div>
    ${itemTable}
    ${speedTable}
    ${dayTable}
    <p class="hint">Electricity ${(E.rate * 100).toFixed(2)}¢/kWh · Gas $${g.rate.toFixed(2)}/${esc(g.unit)}
      · Equipment costs are estimated from run time × rating${E.since ? ` · since ${new Date(E.since + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}</p>`;
}

// ---------- Energy settings ----------
let draftEquip = [];

function sourceOptions() {
  const opts = [{ value: 'heater', label: 'Heater is firing' }];
  const bodyCircuits = new Map(bodies().map((b) => [b.circuit, b.name]));
  for (const c of S?.circuits || []) {
    if ((c.type?.name || '').toLowerCase() === 'notused') continue;
    const label = bodyCircuits.has(c.id) ? `${c.name} mode (pump running)` : c.name;
    opts.push({ value: `circuit:${c.id}`, label });
  }
  for (const f of S?.features || []) opts.push({ value: `feature:${f.id}`, label: f.name || `Feature ${f.id}` });
  return opts;
}

function sourceValue(src) {
  if (!src) return '';
  return src.kind === 'heater' ? 'heater' : `${src.kind}:${src.id}`;
}

function newEquipId() {
  return 'e-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function renderEquipList() {
  const opts = sourceOptions();
  $('equipList').innerHTML = draftEquip.length ? draftEquip.map((e, i) => {
    const sv = sourceValue(e.source);
    const known = opts.some((o) => o.value === sv);
    const optionHtml = (known || !sv ? '' : `<option value="${esc(sv)}" selected>(missing: ${esc(sv)})</option>`) +
      `<option value="" ${sv ? '' : 'selected'} disabled>Pick one…</option>` +
      opts.map((o) => `<option value="${esc(o.value)}" ${o.value === sv ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
    const isGas = e.energy === 'gas';
    return `
      <div class="equip" data-index="${i}">
        <label class="field full"><span>Name</span>
          <input type="text" data-k="name" maxlength="40" value="${esc(e.name)}" placeholder="e.g. Air Blower" required></label>
        <label class="field full"><span>Counted while</span>
          <select data-k="source" required>${optionHtml}</select></label>
        <label class="field"><span>Type</span>
          <select data-k="energy">
            <option value="electric" ${isGas ? '' : 'selected'}>Electric</option>
            <option value="gas" ${isGas ? 'selected' : ''}>Gas</option>
          </select></label>
        <label class="field"><span>Rating</span>
          <div class="unit-input">
            <input type="number" data-k="rating" inputmode="numeric" min="1" step="any" required
              value="${isGas ? (e.btu ?? '') : (e.watts ?? '')}" placeholder="${isGas ? '264000' : '1200'}">
            <span>${isGas ? 'BTU/hr' : 'W'}</span>
          </div></label>
        <label class="field full"><span>Category</span>
          <select data-k="category">
            ${[['pump', 'Pump (shown in the Pump card)'], ['heater', 'Heating'], ['other', 'Other']]
              .map(([v, l]) => `<option value="${v}" ${(e.category || 'other') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        <button type="button" class="link-btn remove" data-remove="${i}">Remove</button>
      </div>`;
  }).join('') : '<p class="empty">Nothing tracked yet. Tap + Add.</p>';
  updateEquipWarn();
}

// Read the form back into draftEquip (keeps typed values when re-rendering).
function readEquipForm() {
  document.querySelectorAll('#equipList .equip').forEach((row) => {
    const e = draftEquip[parseInt(row.dataset.index, 10)];
    e.name = row.querySelector('[data-k="name"]').value;
    const sv = row.querySelector('[data-k="source"]').value;
    e.source = sv === 'heater' ? { kind: 'heater' } : sv ? { kind: sv.split(':')[0], id: parseInt(sv.split(':')[1], 10) } : null;
    e.energy = row.querySelector('[data-k="energy"]').value;
    e.category = row.querySelector('[data-k="category"]').value;
    const rating = parseFloat(row.querySelector('[data-k="rating"]').value);
    if (e.energy === 'gas') { e.btu = rating; delete e.watts; } else { e.watts = rating; delete e.btu; }
  });
}

function updateEquipWarn() {
  const warn = $('equipWarn');
  const bodyIds = new Set(bodies().map((b) => b.circuit));
  const pumpLike = draftEquip.some((e) => e.source?.kind === 'circuit' && bodyIds.has(e.source.id) && e.energy === 'electric');
  warn.hidden = !(pumpLike && E?.live?.pumps);
  warn.textContent = 'Your pump is already measured, so an item linked to Pool/Spa mode would count it twice.';
}

function openSettings() {
  if (!E) { toast('Energy data not loaded yet', true); return; }
  $('setElecRate').value = (E.rate * 100).toFixed(2);
  $('setGasRate').value = E.gas.rate.toFixed(2);
  $('gasRateLabel').textContent = `Gas ($ per ${E.gas.unit})`;
  draftEquip = (E.equipment || []).map(({ perHour, ...e }) => JSON.parse(JSON.stringify(e)));
  renderEquipList();
  $('settingsDialog').showModal();
}

async function saveSettings() {
  readEquipForm();
  const cents = parseFloat($('setElecRate').value);
  const gasRate = parseFloat($('setGasRate').value);
  $('settingsSave').disabled = true;
  try {
    const res = await fetch('/local/energy/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rate: cents / 100, gasRate, equipment: draftEquip }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Could not save');
    E = data;
    renderEnergy();
    if (S) renderPumps();
    $('settingsDialog').close();
    toast('Settings saved');
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('settingsSave').disabled = false;
  }
}

$('settingsForm').addEventListener('submit', (e) => { e.preventDefault(); saveSettings(); });
$('equipList').addEventListener('change', (e) => {
  if (e.target.dataset.k === 'energy' || e.target.dataset.k === 'source') { readEquipForm(); renderEquipList(); }
});
$('settingsDialog').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'addEquip') {
    readEquipForm();
    draftEquip.push({ id: newEquipId(), name: '', source: null, energy: 'electric', watts: undefined, category: 'other' });
    renderEquipList();
    const rows = document.querySelectorAll('#equipList .equip');
    rows[rows.length - 1]?.querySelector('input')?.focus();
  } else if (t.dataset.remove !== undefined) {
    readEquipForm();
    draftEquip.splice(parseInt(t.dataset.remove, 10), 1);
    renderEquipList();
  } else if (t.id === 'settingsCancel') {
    $('settingsDialog').close();
  }
});

// ---------- Pool Remote version ----------
let V = null;
async function loadVersion() {
  try { V = await (await fetch('/local/version')).json(); } catch { V = null; }
  if (S) renderFooter();
}
function versionText() {
  if (!V) return 'Pool Remote';
  const date = V.date ? ` · ${new Date(V.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
  return `Pool Remote v${V.version}${V.commit ? ` (${V.commit})` : ''}${date}`;
}

// ---------- Updates ----------
let UPD = null;
async function loadUpdate(force = false) {
  try {
    const res = await fetch(force ? '/local/update?force=1' : '/local/update');
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Update check failed');
    UPD = data;
    renderUpdate();
    if (force) toast(data.available ? `v${data.latest} is available` : data.blockedReason || `Up to date (v${data.current})`, !!data.blockedReason);
  } catch (err) {
    if (force) toast(err.message, true);
  }
}

function renderUpdate() {
  const u = UPD;
  const show = !!(u && u.available);
  $('updateBar').hidden = !show;
  if (!show) return;
  $('updateTitle').textContent = `Pool Remote v${u.latest} is available`;
  $('updateSub').textContent = `You have v${u.current}. Updating takes about 10 seconds.`;
  $('updateNotes').textContent = u.notes || 'No release notes.';
  $('updateNotesBox').hidden = !u.notes;
}

async function updateNow() {
  const u = UPD;
  if (!u?.available) return;
  if (!confirm(`Update Pool Remote from v${u.current} to v${u.latest}?\n\nThe app restarts on the Pi and this page reloads.`)) return;
  const btn = $('updateNow');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  try {
    const res = await fetch('/local/update', { method: 'POST', headers: { 'x-pool-remote': 'update' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Update failed');
    $('updateSub').textContent = `Restarting with v${data.to}…`;
    // Wait for the restarted server to report the new version, then reload.
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const v = await (await fetch('/local/version', { cache: 'no-store' })).json();
        if (v.version === data.to) { location.reload(); return; }
      } catch { /* still restarting */ }
    }
    throw new Error('Updated, but the app did not come back within 90 s. Check pm2 on the Pi.');
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    btn.textContent = 'Update';
  }
}

$('updateNow').addEventListener('click', updateNow);
$('checkUpdates').addEventListener('click', () => loadUpdate(true));

// ---------- Pi health ----------
let SYS = null;
async function loadSystem() {
  try {
    const res = await fetch('/local/system');
    if (!res.ok) return;
    SYS = await res.json();
    renderSystem();
  } catch { /* keep the last reading */ }
}

function fmtDuration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// Status levels for the strip. Each warning carries a word, never color alone.
function systemFlags(x) {
  const flags = [];
  const p = x.power;
  if (p?.underVoltageNow) flags.push(['bad', 'Low power now']);
  else if (p?.underVoltageSinceBoot) flags.push(['warn', 'Low power earlier']);
  if (p?.throttledNow) flags.push(['bad', 'Slowed down']);
  if (x.tempC >= 80) flags.push(['bad', 'Too hot']);
  else if (x.tempC >= 70) flags.push(['warn', 'Hot']);
  if (x.wifi && x.wifi.dbm <= -80) flags.push(['bad', 'Wi-Fi very weak']);
  else if (x.wifi && x.wifi.dbm <= -70) flags.push(['warn', 'Wi-Fi weak']);
  if (x.disk && x.disk.pct >= 90) flags.push(['warn', 'Disk almost full']);
  if (x.memory && x.memory.pct >= 90) flags.push(['warn', 'Memory almost full']);
  return flags;
}

function wifiWord(dbm) {
  return dbm > -55 ? 'excellent' : dbm > -67 ? 'good' : dbm > -75 ? 'fair' : 'weak';
}

function renderSystem() {
  const x = SYS;
  if (!x) return;
  $('piStrip').hidden = false;
  const parts = [];
  if (typeof x.cpuPct === 'number') parts.push(`<span class="pi-metric">CPU <b>${Math.round(x.cpuPct)}%</b></span>`);
  if (typeof x.tempC === 'number') parts.push(`<span class="pi-metric"><b>${Math.round(x.tempC)}°C</b></span>`);
  if (x.memory) parts.push(`<span class="pi-metric">RAM <b>${Math.round(x.memory.pct)}%</b></span>`);
  if (x.wifi) parts.push(`<span class="pi-metric">Wi-Fi <b>${Math.round(x.wifi.dbm)} dBm</b></span>`);
  for (const [lvl, text] of systemFlags(x)) parts.push(`<span class="pi-flag ${lvl}">⚠ ${esc(text)}</span>`);
  if (!systemFlags(x).length) parts.push('<span class="pi-metric">OK</span>');
  $('piSummary').innerHTML = parts.join('');

  const p = x.power;
  const powerText = !p ? 'Not available' : p.underVoltageNow ? 'Under-voltage now: use the official 2.5 A supply'
    : p.underVoltageSinceBoot ? 'Under-voltage happened since boot' : 'OK';
  const rows = [
    ['Model', x.model],
    ['CPU', typeof x.cpuPct === 'number' ? `${Math.round(x.cpuPct)}% · load ${x.load.map((l) => l.toFixed(2)).join(' / ')} (${x.cores} cores)` : '—'],
    ['Temperature', typeof x.tempC === 'number' ? `${x.tempC.toFixed(1)} °C (${Math.round(x.tempC * 9 / 5 + 32)} °F)` : '—'],
    ['Memory', x.memory ? `${x.memory.usedMB} of ${x.memory.totalMB} MB (${Math.round(x.memory.pct)}%)` : '—'],
    ['Disk', x.disk ? `${x.disk.freeGB.toFixed(1)} GB free of ${x.disk.totalGB.toFixed(1)} GB` : '—'],
    ['Wi-Fi', x.wifi ? `${Math.round(x.wifi.dbm)} dBm (${wifiWord(x.wifi.dbm)})${x.wifi.qualityPct !== null ? ` · quality ${x.wifi.qualityPct}%` : ''}` : 'Not on Wi-Fi'],
    ['Power supply', powerText],
    ['Up for', fmtDuration(x.uptimeSec)],
    ['Pool Remote running for', fmtDuration(x.appUptimeSec)],
  ];
  $('piDetails').innerHTML = `<table class="etable">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
}

$('piStrip').addEventListener('click', () => {
  const open = $('piDetails').hidden;
  $('piDetails').hidden = !open;
  $('piStrip').setAttribute('aria-expanded', String(open));
});

// ---------- Events ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;

  if (t.dataset.mode) return setMode(t.dataset.mode);
  if (t.dataset.setpoint) return bumpSetpoint(parseInt(t.dataset.body, 10), parseInt(t.dataset.setpoint, 10));
  if (t.dataset.heatmode) {
    if (t.getAttribute('aria-pressed') === 'true') return;
    return setHeatMode(parseInt(t.dataset.body, 10), t.dataset.heatmode);
  }
  if (t.dataset.edit) {
    editMode[t.dataset.edit] = !editMode[t.dataset.edit];
    return renderTiles(t.dataset.edit);
  }
  if (t.dataset.kind) {
    const group = t.dataset.group;
    const key = `${t.dataset.kind}:${t.dataset.id}`;
    if (editMode[group]) {
      const list = hidden[group];
      const i = list.indexOf(key);
      if (i >= 0) list.splice(i, 1); else list.push(key);
      saveHidden();
      return renderTiles(group);
    }
    return toggleItem(t.dataset.kind, parseInt(t.dataset.id, 10), t.dataset.on === 'true');
  }
  if (t.dataset.schedule) return openSchedule(parseInt(t.dataset.schedule, 10));
  if (t.id === 'addSchedule') return openSchedule(null);
  if (t.id === 'openSettings') return openSettings();
  if (t.dataset.bit) {
    draftDays ^= parseInt(t.dataset.bit, 10);
    return renderDays();
  }
  if (t.dataset.days) {
    const defs = dayDefs();
    const pick = { all: () => true, weekdays: (d) => d.dow >= 1 && d.dow <= 5, weekends: (d) => d.dow === 0 || d.dow === 6 }[t.dataset.days];
    draftDays = defs.filter(pick).reduce((acc, d) => acc | d.bit, 0);
    return renderDays();
  }
  if (t.id === 'schedCancel') return $('scheduleDialog').close();
  if (t.id === 'schedDelete') return deleteSchedule();
});

$('scheduleForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveSchedule();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { refresh(true); loadEnergy(); }
});

setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, POLL_MS);

setInterval(() => {
  if (document.visibilityState === 'visible') loadEnergy(true);
}, 10000);

setInterval(() => {
  if (document.visibilityState === 'visible') loadSystem();
}, 10000);

refresh(true);
loadEnergy();
loadSystem();
loadVersion();
loadUpdate();
setInterval(() => { if (document.visibilityState === 'visible') loadUpdate(); }, 6 * 60 * 60 * 1000);
