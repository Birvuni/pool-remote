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
  }
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

  const air = S.temps?.air;
  $('airTemp').hidden = typeof air !== 'number';
  $('airValue').textContent = `${fmtTemp(air)}°`;
}

function renderHero() {
  const list = bodies();
  const active = list.find((b) => b.isOn) || list[0];
  $('heroUnit').textContent = unit();
  if (!active) {
    $('heroLabel').textContent = 'Water';
    $('heroTemp').textContent = '--';
    $('heroSub').innerHTML = '&nbsp;';
    return;
  }
  const anyOn = list.some((b) => b.isOn);
  $('heroLabel').textContent = `${active.name || 'Pool'} water`;
  $('heroTemp').textContent = fmtTemp(active.temp);
  const parts = [];
  const heating = active.heatStatus && active.heatStatus.name && active.heatStatus.name !== 'off';
  if (heating) parts.push(`<span class="badge heating">Heating</span>`);
  const sp = setpointDraft[active.id] ?? active.setPoint;
  const modeName = active.heatMode?.name;
  if (modeName && modeName !== 'off' && typeof sp === 'number') parts.push(`<span>Heat to ${sp}°</span>`);
  if (!anyOn) parts.push('<span class="badge">Pump off · last reading</span>');
  $('heroSub').innerHTML = parts.join('') || '&nbsp;';
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
  const pumps = (S.pumps || []).filter((p) => p && p.id);
  const anyBodyOn = bodies().some((b) => b.isOn);
  if (pumps.length === 0) {
    const on = bodies().find((b) => b.isOn);
    $('pumpList').innerHTML = `
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
  $('footer').textContent = `Updated ${time}${ver}`;
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
  if (document.visibilityState === 'visible') refresh(true);
});

setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, POLL_MS);

refresh(true);
