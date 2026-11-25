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
  renderLightThemes();
  renderLightsPower();
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
  const st = staleInfo();
  if (st) {
    dot.className = 'dot bad';
    text.textContent = `No data from the controller since ${st.sinceText}`;
    return;
  }
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

// poolController stopped getting status from the controller: its data (and this screen) is frozen.
// The Pool Remote server detects it (panel clock not advancing); as a fallback, a panel clock far
// behind real time means the same.
function staleInfo() {
  let since = null;
  if (E?.live?.stale) since = E.live.staleSince;
  else {
    const raw = typeof S?.time === 'string' ? S.time.replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : '';
    const t = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(t) || Date.now() - t < 2 * 3600 * 1000) return null;
    since = new Date(t).toISOString();
  }
  const d = since ? new Date(since) : null;
  const sinceText = d && !isNaN(d) ? d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'a while ago';
  return { since, sinceText };
}

function renderHero() {
  const list = bodies();
  const active = list.find((b) => b.isOn) || list[0];
  $('heroUnit').textContent = unit();
  const air = S.temps?.air;
  $('heroAir').hidden = typeof air !== 'number';
  $('heroAirTemp').textContent = fmtTemp(air);
  if (!active) {
    $('hero').classList.remove('spa-on', 'pool-on');
    $('heroLabel').textContent = 'Water';
    $('heroTemp').textContent = '--';
    $('heroSub').innerHTML = '&nbsp;';
    renderNow();
    return;
  }
  const anyOn = list.some((b) => b.isOn);
  const spaOn = !!(active.isOn && (/spa/i.test(active.name || '') || active.id === 2));
  $('hero').classList.toggle('spa-on', spaOn);
  $('hero').classList.toggle('pool-on', !!active.isOn && !spaOn);
  $('heroLabel').textContent = `${active.name || 'Pool'} water`;
  $('heroTemp').textContent = fmtTemp(active.temp);
  const parts = [];
  if (isHeating(active)) parts.push(`<span class="badge heating">Heating</span>`);
  const sp = setpointDraft[active.id] ?? active.setPoint;
  const modeName = active.heatMode?.name;
  if (modeName && modeName !== 'off' && typeof sp === 'number') parts.push(`<span>Heat to ${sp}°</span>`);
  if (!anyOn) parts.push('<span class="badge">Pump off · last reading</span>');
  if (staleInfo()) parts.unshift('<span class="badge stale-badge">⚠ Not updating</span>');
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
  const st = staleInfo();
  if (st) {
    rows.push(['⚠ Frozen', `This is the state as of ${st.sinceText}. poolController stopped getting updates from the controller; restart it on the Pi: pm2 restart poolController`]);
  }
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
  if (E && !st) {
    let perHour = (E.live?.watts || 0) / 1000 * E.rate;
    for (const e of E.equipment || []) if (equipIsOn(e)) perHour += e.perHour?.cost || 0;
    rows.push(['Cost now', perHour > 0 ? `${money(perHour)}/hr` : '$0.00/hr']);
  }
  $('heroNow').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

// A mode change in progress: the chosen button blinks until the controller reports that mode.
const MODE_SWITCH_TIMEOUT_MS = 2 * 60 * 1000;
let modeSwitch = null;   // { target: 'off' | body id (string), since }
let modeSwitchTimer = null;

function modeReached(target) {
  const list = bodies();
  if (target === 'off') return !list.some((b) => b.isOn);
  return !!list.find((b) => String(b.id) === String(target))?.isOn;
}

function modeName(target) {
  if (target === 'off') return 'Off';
  return bodies().find((b) => String(b.id) === String(target))?.name || 'the new mode';
}

function startModeSwitch(target) {
  modeSwitch = { target: String(target), since: Date.now() };
  clearInterval(modeSwitchTimer);
  modeSwitchTimer = setInterval(renderMode, 1000); // checks for success / timeout
  renderMode();
}

function endModeSwitch() {
  modeSwitch = null;
  clearInterval(modeSwitchTimer);
  modeSwitchTimer = null;
}

function renderMode() {
  const list = bodies();
  if (modeSwitch && S) {
    if (modeReached(modeSwitch.target)) endModeSwitch();
    else if (Date.now() - modeSwitch.since > MODE_SWITCH_TIMEOUT_MS) {
      toast(`Still not in ${modeName(modeSwitch.target)} mode after 2 minutes. Check the controller.`, true);
      endModeSwitch();
    }
  }
  const sw = modeSwitch?.target ?? null;
  const activeIds = list.filter((b) => b.isOn).map((b) => b.id);
  const busy = isBusy('mode');
  // While switching, show the chosen mode as selected (blinking) instead of the old one.
  const checked = (key, isActive) => (sw !== null ? sw === key : isActive);
  const cls = (key, extra) => [extra, sw === key ? 'switching' : ''].filter(Boolean).join(' ');
  const btns = [`<button role="radio" class="${cls('off')}" data-mode="off" aria-checked="${checked('off', activeIds.length === 0)}" ${sw === 'off' ? 'aria-busy="true"' : ''} ${busy ? 'disabled' : ''}>Off</button>`];
  for (const b of list) {
    const isSpa = (b.type?.name || '').toLowerCase() === 'spa' || /spa/i.test(b.name || '');
    const key = String(b.id);
    btns.push(`<button role="radio" class="${cls(key, isSpa ? 'spa' : '')}" data-mode="${b.id}" aria-checked="${checked(key, activeIds.includes(b.id))}" ${sw === key ? 'aria-busy="true"' : ''} ${busy ? 'disabled' : ''}>${esc(b.name || 'Body ' + b.id)}</button>`);
  }
  // Redraw only when something changed: rebuilding the buttons on every poll restarted the blink.
  const html = btns.join('');
  if ($('modeButtons').dataset.html !== html) {
    $('modeButtons').innerHTML = html;
    $('modeButtons').dataset.html = html;
    // Keep the blink on one shared clock, so a redraw (e.g. the button re-enabling) continues
    // the fade where it was instead of jumping back to full brightness.
    const b = $('modeButtons').querySelector('.switching');
    if (b) b.style.animationDelay = `-${Date.now() % 2000}ms`;
  }
  const on = list.find((b) => b.isOn);
  $('modeHint').textContent = sw !== null
    ? `Switching to ${modeName(sw)}… valves and pump can take a minute.`
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

// ---------- IntelliBrite colors ----------
// The EasyTouch groups IntelliBrite lights into a light group (id 192, "Intellibrite"); setting the
// group's theme switches every IntelliBrite light to it (and turns them on).
const INTELLIBRITE_THEMES = [
  { name: 'party', label: 'Party', show: true, swatch: 'linear-gradient(90deg, #ff3b3b, #ffb300, #2ecc71, #1e90ff, #b44bff)' },
  { name: 'romance', label: 'Romance', show: true, swatch: 'linear-gradient(135deg, #ff4d8d, #b0306a)' },
  { name: 'caribbean', label: 'Caribbean', show: true, swatch: 'linear-gradient(135deg, #00c2c7, #1e6bff, #2ecc71)' },
  { name: 'american', label: 'American', show: true, swatch: 'linear-gradient(90deg, #e53935 0 33%, #ffffff 33% 66%, #1e4bd8 66%)' },
  { name: 'sunset', label: 'Sunset', show: true, swatch: 'linear-gradient(135deg, #ff8a00, #ff3d6e, #7b2ff7)' },
  { name: 'royal', label: 'Royal', show: true, swatch: 'linear-gradient(135deg, #5b2bd9, #1e3a8a)' },
  { name: 'blue', label: 'Blue', swatch: '#1e6bff' },
  { name: 'green', label: 'Green', swatch: '#22b14c' },
  { name: 'red', label: 'Red', swatch: '#e53935' },
  { name: 'white', label: 'White', swatch: '#ffffff' },
  { name: 'magenta', label: 'Magenta', swatch: '#d81b9a' },
];

function intellibriteGroup() {
  const hasIntellibrite = (S?.circuits || []).some((c) => (c.type?.name || '').toLowerCase() === 'intellibrite');
  if (!hasIntellibrite) return null;
  return (S.lightGroups || []).find((g) => g && g.isActive !== false && /intellibrite/i.test(g.name || '')) || null;
}

function renderLightThemes() {
  const box = $('lightThemes');
  const g = intellibriteGroup();
  box.hidden = !g;
  if (!g) return;
  const lightsOn = (S.circuits || []).some((c) => (c.type?.name || '').toLowerCase() === 'intellibrite' && c.isOn);
  const current = (g.lightingTheme?.name || '').toLowerCase();
  const chip = (t) => {
    const pressed = lightsOn && current === t.name;
    const busy = isBusy('theme:' + t.name);
    return `<button type="button" class="${t.show ? 'show-card' : 'color-dot'} theme-chip ${busy ? 'busy' : ''}" data-theme="${t.name}" aria-pressed="${pressed}">
      <span class="sw${t.name === 'white' ? ' light-sw' : ''}" style="background:${t.swatch}" aria-hidden="true"></span><span class="nm">${esc(t.label)}</span></button>`;
  };
  const now = INTELLIBRITE_THEMES.find((t) => t.name === current);
  box.innerHTML = `
    <div class="lt-label">Light shows</div>
    <div class="show-grid">${INTELLIBRITE_THEMES.filter((t) => t.show).map(chip).join('')}</div>
    <div class="lt-label">Colors</div>
    <div class="color-grid">${INTELLIBRITE_THEMES.filter((t) => !t.show).map(chip).join('')}</div>
    <p class="hint lt-now">${lightsOn && current
      ? `<span class="sw" style="background:${now ? now.swatch : 'var(--accent)'}"></span>Now showing <b>${esc(now?.label || g.lightingTheme?.desc || current)}</b>`
      : 'Tap a show or color: the lights turn on in it.'}</p>`;
}

async function setLightTheme(name) {
  const g = intellibriteGroup();
  if (!g) return;
  const label = (INTELLIBRITE_THEMES.find((t) => t.name === name) || {}).label || name;
  await withPending('theme:' + name, async () => {
    await api('PUT', '/state/circuit/setTheme', { id: g.id, theme: name });
    toast(`Lights: ${label}`);
  });
}

function intellibriteCircuits() {
  return (S?.circuits || []).filter((c) => (c.type?.name || '').toLowerCase() === 'intellibrite');
}

// With IntelliBrite, the lights' on/off is the small power button next to "Lights";
// the shows and colors below do the rest, so the IntelliBrite circuits get no tile.
function renderLightsPower() {
  const btn = $('lightsPower');
  const ib = intellibriteGroup() ? intellibriteCircuits() : [];
  btn.hidden = ib.length === 0;
  if (!ib.length) return;
  const on = ib.some((c) => c.isOn);
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'Lights are on. Turn off' : 'Lights are off. Turn on');
  btn.classList.toggle('busy', isBusy('lights-power'));
  $('lightsPowerText').textContent = on ? 'On' : 'Off';
}

async function toggleLightsPower() {
  const ib = intellibriteCircuits();
  if (!ib.length) return;
  const turnOn = !ib.some((c) => c.isOn);
  await withPending('lights-power', async () => {
    for (const c of ib) if (!!c.isOn !== turnOn) await api('PUT', '/state/circuit/setState', { id: c.id, isOn: turnOn });
  });
}

function renderTiles(group) {
  let items = tileItems(group);
  if (group === 'lights' && intellibriteGroup()) {
    const ibIds = new Set(intellibriteCircuits().map((c) => c.id));
    const all = items;
    items = items.filter((i) => !(i.kind === 'circuit' && ibIds.has(i.id)));
    const section = $('lightsSection');
    section.hidden = all.length === 0;
    $('lightTiles').hidden = items.length === 0;
    section.querySelector('[data-edit]').hidden = items.length === 0;
    if (!items.length) return;
  } else if (group === 'lights') {
    $('lightTiles').hidden = false;
    $('lightsSection').querySelector('[data-edit]').hidden = false;
  }
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
  if (modeSwitch?.target === String(target)) return; // already switching there
  if (!modeSwitch && modeReached(target)) return;     // already in that mode
  startModeSwitch(target);
  await withPending('mode', async () => {
    try { await sendMode(target); } catch (err) { endModeSwitch(); throw err; }
  });
  renderMode();
}

async function sendMode(target) {
  {
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
  }
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
    if (S) { renderPumps(); renderNow(); renderStatus(); renderHero(); }
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

const PERIOD_KEY = 'poolRemote.energyPeriod';
let energyPeriod = (() => { try { return localStorage.getItem(PERIOD_KEY) || 'today'; } catch { return 'today'; } })();
function setEnergyPeriod(p) {
  energyPeriod = p;
  try { localStorage.setItem(PERIOD_KEY, p); } catch { /* storage unavailable */ }
  renderEnergy();
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

  // Tap Today / Last 7 days / This month: the details below follow the chosen period.
  const P = { today: E.today, week: E.week, month: E.month };
  if (!P[energyPeriod]) energyPeriod = 'today';
  const sel = P[energyPeriod];
  const periodName = { today: 'Today', week: 'Last 7 days', month: 'This month' }[energyPeriod];
  const stat = (key, label, s, extra = '') => `
    <button type="button" class="stat" data-period="${key}" aria-pressed="${energyPeriod === key}">
      <span class="label">${label}</span>
      <span class="cost">${money(s.totalCost)}</span>
      <span class="kwh">Elec ${money(s.elecCost)}<br>Gas ${money(s.gasCost)}${extra}</span>
    </button>`;
  const proj = E.month.projected;
  const projText = proj ? `<br>≈ $${Math.round(proj.totalCost)}/mo` : '';

  // By equipment for the chosen period.
  const itemRows = [];
  if (sel.pumpKWh > 0) itemRows.push(`<tr><td>Pump (measured)</td><td>${hours(sel.runSeconds)}</td><td>${kwh(sel.pumpKWh)}</td><td>${money(sel.pumpCost)}</td></tr>`);
  for (const e of E.equipment || []) {
    const it = sel.items[e.id];
    if (!it || it.seconds < 30) continue;
    itemRows.push(`<tr><td>${esc(e.name)}</td><td>${hours(it.seconds)}</td><td>${itemEnergyText(e, it)}</td><td>${money(it.cost)}</td></tr>`);
  }
  if (itemRows.length > 1) itemRows.push(`<tr class="total"><td>Total</td><td></td><td></td><td>${money(sel.totalCost)}</td></tr>`);
  const itemTable = `
    <div class="subhead">By equipment</div>
    ${itemRows.length ? `<table class="etable">
      <tr><th>Equipment</th><th>Time</th><th>Energy</th><th>Cost</th></tr>
      ${itemRows.join('')}
    </table>` : `<p class="empty">Nothing ran ${energyPeriod === 'today' ? 'today' : 'in this period'}.</p>`}`;

  const speeds = (sel.bySpeed || []).filter((s) => s.seconds >= 30).slice(0, 8);
  const speedTable = speeds.length ? `
    <div class="subhead">Pump by speed</div>
    <table class="etable">
      <tr><th>Speed</th><th>Time</th><th>Avg power</th><th>Cost</th></tr>
      ${speeds.map((s) => `<tr><td>${s.rpm.toLocaleString()} RPM</td><td>${hours(s.seconds)}</td><td>${Math.round(s.avgWatts).toLocaleString()} W</td><td>${money(s.cost)}</td></tr>`).join('')}
    </table>` : '';

  const todayKey = E.days?.[0]?.date;
  const days = sel.days || [];
  const dayTable = days.length ? `
    <div class="subhead">By day</div>
    <table class="etable">
      <tr><th>Day</th><th>Electric</th><th>Gas</th><th>Total</th></tr>
      ${days.map((d) => {
        const label = d.date === todayKey ? 'Today' : new Date(d.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        return `<tr><td>${label}</td><td>${money(d.elecCost)}</td><td>${d.gasCost ? money(d.gasCost) : '—'}</td><td>${money(d.totalCost)}</td></tr>`;
      }).join('')}
    </table>` : '';

  box.innerHTML = `
    <div class="live">${rows.join('')}</div>
    ${pumpNote}
    <div class="stats" role="group" aria-label="Period">
      ${stat('today', 'Today', E.today)}
      ${stat('week', 'Last 7 days', E.week)}
      ${stat('month', 'This month', E.month, projText)}
    </div>
    <div class="period-detail">
      <div class="period-title">${periodName} · details</div>
      ${itemTable}
      ${speedTable}
      ${dayTable}
    </div>
${loggerNote()}
    <p class="hint">Electricity ${(E.rate * 100).toFixed(2)}¢/kWh · Gas $${g.rate.toFixed(2)}/${esc(g.unit)}
      · Equipment costs are estimated from run time × rating${E.since ? ` · since ${new Date(E.since + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}</p>`;
}

// Is the energy log actually recording? Warn when it isn't, quietly confirm when it is.
function loggerNote() {
  const l = E?.logger;
  if (!l) return '';
  const ago = (t) => {
    const s = Math.max(0, Math.round((l.now - t) / 1000));
    return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };
  const recent = (t) => t && l.now - t < 5 * 60e3;
  const warn = [];
  if (l.startsLastHour >= 3) warn.push(`Pool Remote stopped unexpectedly ${l.startsLastHour} times in the last hour, so recent usage may be missing. It may be crashing: run <code>pm2 logs poolRemote --lines 50</code> on the Pi.`);
  if (recent(l.lastStaleAt)) warn.push('Not recording: poolController\'s data is frozen (see the red status at the top).');
  if (recent(l.lastErrorAt)) warn.push(`Couldn't read poolController ${ago(l.lastErrorAt)}: ${esc(l.lastError || 'error')}.`);
  if (l.saveError) warn.push(`Can't save the energy log: ${esc(l.saveError)}.`);
  if (!l.lastRecordAt && l.now - l.startedAt > 3 * l.sampleMs) warn.push('Nothing recorded since Pool Remote started.');
  if (warn.length) return `<p class="warn-note logger-note"><b>Energy log:</b> ${warn.join(' ')}</p>`;
  return `<p class="hint logger-ok">● Recording · last reading ${l.lastRecordAt ? ago(l.lastRecordAt) : '—'} · saved ${l.savedAt ? ago(l.savedAt) : '—'}</p>`;
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
  $('updateNotes').innerHTML = notesHtml(u.notes || 'No release notes.');
  $('updateNotesBox').hidden = !u.notes;
}

// Changelog markdown -> simple HTML (escaped first; only headings, bullets, **bold**, `code`).
function notesHtml(md) {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = false;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = /^##\s+(.*)$/.exec(line);
    const li = /^-\s+(.*)$/.exec(line);
    const cont = /^\s{2,}\S/.test(raw) && list;
    if (cont) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ' ' + inline(line.trim()) + '</li>'); continue; }
    if (list && !li) { out.push('</ul>'); list = false; }
    if (h) out.push(`<h4>${inline(h[1])}</h4>`);
    else if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); }
    else if (line) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
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

// Update history: the whole CHANGELOG.md, one block per release.
async function openChangelog() {
  const body = $('changelogBody');
  body.innerHTML = '<p class="hint">Loading…</p>';
  $('changelogDialog').showModal();
  try {
    const r = await fetch('/local/changelog', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const { version, text } = await r.json();
    const sections = text.split(/^## /m).slice(1); // drop the intro above the first release
    body.innerHTML = sections.map((s) => {
      const nl = s.indexOf('\n');
      const head = (nl < 0 ? s : s.slice(0, nl)).trim();
      const [ver, date] = head.split(/\s+—\s+/);
      const installed = ver === version;
      return `<section class="cl-release${installed ? ' current' : ''}">
        <div class="cl-head"><b>v${esc(ver)}</b>${date ? `<span>${esc(date)}</span>` : ''}${installed ? '<span class="cl-badge">Installed</span>' : ''}</div>
        ${notesHtml(nl < 0 ? '' : s.slice(nl + 1))}
      </section>`;
    }).join('') || '<p class="hint">No releases listed.</p>';
  } catch (err) {
    body.innerHTML = `<p class="hint">Couldn't load the update history (${esc(err.message)}).</p>`;
  }
}
$('openChangelog').addEventListener('click', openChangelog);
$('changelogClose').addEventListener('click', () => $('changelogDialog').close());

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

// Pi health: four equal tiles (CPU, temperature, memory, Wi-Fi), each with a value and a status
// word, plus full-width notes for things that aren't a single number (power supply, disk).
// Status is always a word as well as a color.
function piTiles(x) {
  const tiles = [];
  const cpu = typeof x.cpuPct === 'number' ? Math.round(x.cpuPct) : null;
  tiles.push(cpu === null ? ['CPU', '—', 'Measuring', 'ok']
    : [`CPU`, `${cpu}%`, cpu >= 90 ? 'Very busy' : cpu >= 70 ? 'Busy' : 'OK', cpu >= 90 ? 'bad' : cpu >= 70 ? 'warn' : 'ok']);
  if (typeof x.tempC === 'number') {
    const shown = unit() === '°C' ? `${Math.round(x.tempC)}°C` : `${Math.round(x.tempC * 9 / 5 + 32)}°F`;
    tiles.push(['Chip temp', shown, x.tempC >= 80 ? 'Too hot' : x.tempC >= 70 ? 'Hot' : 'OK', x.tempC >= 80 ? 'bad' : x.tempC >= 70 ? 'warn' : 'ok']);
  } else tiles.push(['Chip temp', '—', 'No sensor', 'ok']);
  const mem = x.memory ? Math.round(x.memory.pct) : null;
  tiles.push(mem === null ? ['Memory', '—', '', 'ok'] : ['Memory', `${mem}%`, mem >= 90 ? 'Almost full' : 'OK', mem >= 90 ? 'warn' : 'ok']);
  if (x.wifi) {
    const d = Math.round(x.wifi.dbm);
    const word = d > -55 ? 'Excellent' : d > -67 ? 'Good' : d > -70 ? 'Fair' : d > -80 ? 'Weak' : 'Very weak';
    tiles.push(['Wi-Fi', `${d} dBm`, word, d <= -80 ? 'bad' : d <= -70 ? 'warn' : 'ok']);
  } else tiles.push(['Wi-Fi', '—', 'Not on Wi-Fi', 'ok']);
  return tiles;
}

function piNotes(x) {
  const notes = [];
  const p = x.power;
  if (p?.underVoltageNow) notes.push(['bad', '<b>Low power right now.</b> The Pi isn\'t getting enough voltage, which can corrupt its SD card. Use the official 5.1 V 2.5 A supply.']);
  else if (p?.underVoltageSinceBoot) notes.push(['warn', '<b>Power dipped since the Pi started.</b> Its supply briefly dropped below 5 V. If this keeps showing, use the official 2.5 A supply or a shorter cable.']);
  if (p?.throttledNow) notes.push(['bad', '<b>The Pi is slowing itself down</b> because of heat or low power.']);
  if (x.disk && x.disk.pct >= 90) notes.push(['warn', `<b>Storage almost full:</b> ${x.disk.freeGB.toFixed(1)} GB left.`]);
  return notes;
}

function wifiWord(dbm) {
  return dbm > -55 ? 'excellent' : dbm > -67 ? 'good' : dbm > -70 ? 'fair' : dbm > -80 ? 'weak' : 'very weak';
}

function renderSystem() {
  const x = SYS;
  if (!x) return;
  $('piStrip').hidden = false;
  const tiles = piTiles(x);
  const notes = piNotes(x);
  $('piSummary').innerHTML = tiles.map(([k, v, s, lvl]) => `
    <div class="pi-tile lvl-${lvl}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span><span class="s">${lvl === 'ok' ? '' : '⚠ '}${esc(s)}</span></div>`).join('');
  $('piNotes').innerHTML = notes.map(([lvl, html]) => `<div class="pi-note lvl-${lvl}">${html}</div>`).join('');
  const levels = tiles.map((t) => t[3]).concat(notes.map((n) => n[0]));
  const bad = levels.filter((l) => l === 'bad').length, warn = levels.filter((l) => l === 'warn').length;
  $('piOverall').innerHTML = bad ? `<span class="dot bad"></span>Needs attention`
    : warn ? `<span class="dot warn"></span>${warn} warning${warn > 1 ? 's' : ''}` : '<span class="dot ok"></span>All good';

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

$('piToggle').addEventListener('click', () => {
  const open = $('piDetails').hidden;
  $('piDetails').hidden = !open;
  $('piToggle').setAttribute('aria-expanded', String(open));
  $('piToggle').textContent = open ? 'Hide' : 'Details';
});

// ---------- Events ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;

  if (t.dataset.mode) return setMode(t.dataset.mode);
  if (t.dataset.theme) return setLightTheme(t.dataset.theme);
  if (t.id === 'lightsPower') return toggleLightsPower();
  if (t.dataset.period) return setEnergyPeriod(t.dataset.period);
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
