// Energy logger.
//
// Every SAMPLE_MS it reads nodejs-poolController (/state/all) and records:
//   - measured pump power (watts/RPM from pumps that report it, e.g. IntelliFlo) -> kWh
//   - run time of each configured equipment item while its linked circuit/feature is on
//     (or, for the "heater" source, while the controller is calling for gas heat)
// Daily totals live in data/energy.json. Equipment energy/cost is computed from run time
// and the item's current rating, so fixing a wrong rating also corrects past days.

const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'energy.json');
const SAMPLE_MS = parseInt(process.env.ENERGY_SAMPLE_MS || '30000', 10);
const SAVE_MS = 5 * 60 * 1000;
const MAX_GAP_MS = 3 * 60 * 1000; // don't count time across gaps longer than this (Pi or njsPC was down)
const KEEP_DAYS = 400;
const RPM_BUCKET = 50;
const MAX_EQUIPMENT = 30;
// heatStatus names that mean a gas heater is firing (not solar or a heat pump).
const GAS_HEAT_STATUSES = new Set(['heater', 'mtheater', 'hybheat']);

const CATEGORIES = ['pump', 'heater', 'other'];

// Category for items saved before categories existed.
function inferCategory(e) {
  if (e.source?.kind === 'heater' || e.energy === 'gas') return 'heater';
  return /pump/i.test(e.name || '') ? 'pump' : 'other';
}

let store = load();
let last = null; // previous sample: { at, watts, rpm, on: { [equipId]: true } }
let live = { watts: 0, rpm: 0, flow: 0, on: {}, at: null, ok: false, pumps: 0 };
let dirty = false;
// Frozen-data watchdog: poolController's copy of the panel clock (state.time) advances every few
// seconds while it receives status from the controller. If it stops, its data is stale.
const STALE_MS = 3 * 60 * 1000;      // no panel-clock change for this long = stale
const STALE_SKEW_MS = 2 * 3600 * 1000; // or the panel clock is this far behind real time
let panelTimeSeen = null;   // last state.time string
let panelChangedAt = 0;     // when it last changed (ms)

function parsePanelTime(s) {
  if (typeof s !== 'string' || !s) return null;
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? t : null;
}

// { stale, since } from a /state/all snapshot. since = the frozen panel time (ISO) when known.
function freshness(state, now) {
  const raw = state?.time || '';
  if (raw !== panelTimeSeen) { panelTimeSeen = raw; panelChangedAt = now; }
  const panelMs = parsePanelTime(raw);
  const notAdvancing = panelChangedAt && now - panelChangedAt > STALE_MS;
  const farBehind = panelMs !== null && now - panelMs > STALE_SKEW_MS;
  const stale = !raw || notAdvancing || farBehind;
  return { stale, since: panelMs !== null ? new Date(panelMs).toISOString() : null };
}
let njspc = null;        // poolController URL, set by start()
let sampling = null;     // in-flight sample (so concurrent requests share one)


function defaultHeater(btu) {
  return { id: 'heater', name: 'Gas heater', source: { kind: 'heater' }, energy: 'gas', btu, category: 'heater' };
}

function defaultStore() {
  return {
    version: 3,
    rate: parseFloat(process.env.ENERGY_RATE || '0.14'),
    gas: {
      rate: parseFloat(process.env.GAS_RATE || '2.97'), // $ per billing unit
      unit: process.env.GAS_UNIT || 'CCF',
      btuPerUnit: parseFloat(process.env.GAS_BTU_PER_UNIT || '103700'), // 1 CCF ≈ 103,700 BTU
    },
    equipment: [defaultHeater(parseFloat(process.env.GAS_INPUT_BTU || '264000'))],
    days: {},
  };
}

// Upgrade older files: v1 (pump only) and v2 (pump + fixed heater with heatSeconds).
function migrate(s) {
  const d = defaultStore();
  s.gas = { ...d.gas, ...(s.gas || {}) };
  if (!Array.isArray(s.equipment)) {
    s.equipment = [defaultHeater(s.gas.inputBtu || d.equipment[0].btu)];
  }
  delete s.gas.inputBtu;
  for (const e of s.equipment) if (!CATEGORIES.includes(e.category)) e.category = inferCategory(e);
  for (const day of Object.values(s.days)) {
    if (day.heatSeconds) {
      day.equip = day.equip || {};
      day.equip.heater = (day.equip.heater || 0) + day.heatSeconds;
    }
    delete day.heatSeconds;
  }
  s.version = 3;
  return s;
}

function load() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return defaultStore(); } // first run
  try {
    const s = JSON.parse(raw);
    if (s && typeof s.days === 'object') return migrate(s);
    throw new Error('unexpected file format');
  } catch (err) {
    // Keep the unreadable file instead of overwriting it with an empty history on the next save.
    const keep = `${FILE}.unreadable-${Date.now()}`;
    try { fs.copyFileSync(FILE, keep); } catch { /* best effort */ }
    console.error(`energy: could not load ${FILE} (${err.message}); saved a copy as ${keep} and started fresh`);
    return defaultStore();
  }
}

function save() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, FILE);
    dirty = false;
  } catch (err) {
    console.error('energy: save failed:', err.message);
  }
}

// Local calendar date (the Pi's time zone), e.g. "2026-11-20".
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getDay(key) {
  const d = store.days[key] || (store.days[key] = {});
  d.kWh ??= 0;
  d.runSeconds ??= 0;
  d.maxWatts ??= 0;
  d.bySpeed ??= {};
  d.equip ??= {};
  return d;
}

function prune() {
  const keys = Object.keys(store.days).sort();
  while (keys.length > KEEP_DAYS) delete store.days[keys.shift()];
}

// Add usage for [from, to] assuming the sample's values held the whole time; splits at midnight.
// sample = { watts, rpm, on: { [equipId]: true } }
function accumulate(from, to, sample) {
  const { watts = 0, rpm = 0, on = {} } = sample;
  let t = from;
  while (t < to) {
    const d = new Date(t);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const end = Math.min(to, midnight);
    const seconds = (end - t) / 1000;
    const day = getDay(dayKey(t));
    const kWh = (watts * seconds) / 3.6e6;
    day.kWh += kWh;
    if (watts > 0) {
      day.runSeconds += seconds;
      day.maxWatts = Math.max(day.maxWatts, watts);
      const bucket = String(Math.round(rpm / RPM_BUCKET) * RPM_BUCKET);
      const b = day.bySpeed[bucket] || (day.bySpeed[bucket] = { kWh: 0, seconds: 0 });
      b.kWh += kWh;
      b.seconds += seconds;
    }
    for (const id of Object.keys(on)) {
      if (on[id]) day.equip[id] = (day.equip[id] || 0) + seconds;
    }
    t = end;
  }
  dirty = true;
}

function getJson(njspcUrl, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: njspcUrl.hostname, port: njspcUrl.port || 80, path: urlPath, timeout: 10000 },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Which equipment items are running, given a /state/all snapshot.
function equipmentOn(state) {
  const on = {};
  const heating = (state?.temps?.bodies || []).some((b) => GAS_HEAT_STATUSES.has((b?.heatStatus?.name || '').toLowerCase()));
  const isOn = (list, id) => !!(list || []).find((x) => x && x.id === id)?.isOn;
  for (const e of store.equipment) {
    const src = e.source || {};
    let running = false;
    if (src.kind === 'heater') running = heating;
    else if (src.kind === 'circuit') running = isOn(state.circuits, src.id);
    else if (src.kind === 'feature') running = isOn(state.features, src.id);
    if (running) on[e.id] = true;
  }
  return on;
}

async function sample(njspcUrl) {
  const now = Date.now();
  try {
    const state = await getJson(njspcUrl, '/state/all');
    const pumps = (Array.isArray(state.pumps) ? state.pumps : []).filter((p) => p && p.id);
    let watts = 0, rpm = 0, flow = 0, reporting = 0;
    for (const p of pumps) {
      // A variable-speed pump counts as reporting even while off (poolController omits watts then).
      if (typeof p.watts === 'number' || ['vs', 'vssvrs', 'vsf', 'vf'].includes((p.type?.name || '').toLowerCase())) reporting++;
      if (typeof p.watts === 'number' && p.watts > 0) watts += p.watts;
      if (typeof p.rpm === 'number') rpm = Math.max(rpm, p.rpm);
      if (typeof p.flow === 'number') flow = Math.max(flow, p.flow);
    }
    const on = equipmentOn(state);
    const fresh = freshness(state, now);
    if (fresh.stale) {
      // Don't record frozen data as if equipment kept running (it isn't real usage).
      last = null;
      live = { watts, rpm, flow, on, at: new Date(now).toISOString(), ok: true, pumps: reporting, stale: true, staleSince: fresh.since };
      return;
    }
    if (last && now - last.at <= MAX_GAP_MS) accumulate(last.at, now, last);
    last = { at: now, watts, rpm, on };
    live = { watts, rpm, flow, on, at: new Date(now).toISOString(), ok: true, pumps: reporting, stale: false };
  } catch (err) {
    last = null;
    live = { ...live, ok: false, error: err.message };
  }
}

// Hourly energy and cost of one equipment item at its rating.
function itemPerHour(e) {
  if (e.energy === 'gas') {
    const units = e.btu / store.gas.btuPerUnit;
    return { gasUnits: units, kWh: 0, cost: units * store.gas.rate };
  }
  const kWh = e.watts / 1000;
  return { gasUnits: 0, kWh, cost: kWh * store.rate };
}

function summarize(keys) {
  const out = { pumpKWh: 0, runSeconds: 0, items: {} };
  for (const e of store.equipment) out.items[e.id] = { seconds: 0 };
  for (const k of keys) {
    const d = store.days[k];
    if (!d) continue;
    out.pumpKWh += d.kWh || 0;
    out.runSeconds += d.runSeconds || 0;
    for (const [id, s] of Object.entries(d.equip || {})) {
      if (out.items[id]) out.items[id].seconds += s;
    }
  }
  out.pumpCost = out.pumpKWh * store.rate;
  out.elecCost = out.pumpCost;
  out.kWh = out.pumpKWh;
  out.gasUnits = 0;
  out.gasCost = 0;
  for (const e of store.equipment) {
    const it = out.items[e.id];
    const ph = itemPerHour(e);
    const h = it.seconds / 3600;
    it.kWh = ph.kWh * h;
    it.gasUnits = ph.gasUnits * h;
    it.cost = ph.cost * h;
    if (e.energy === 'gas') { out.gasUnits += it.gasUnits; out.gasCost += it.cost; }
    else { out.kWh += it.kWh; out.elecCost += it.cost; }
  }
  out.totalCost = out.elecCost + out.gasCost;
  return out;
}

function report() {
  const now = new Date();
  const today = dayKey(now.getTime());
  const lastNDays = (n) => Array.from({ length: n }, (_, i) =>
    dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).getTime()));
  const monthPrefix = today.slice(0, 7);
  const monthKeys = Object.keys(store.days).filter((k) => k.startsWith(monthPrefix));
  const month = summarize(monthKeys);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const completed = monthKeys.filter((k) => k !== today);
  // Full-month projection at the pace of the completed days logged so far.
  let projected = null;
  if (completed.length) {
    const c = summarize(completed);
    projected = { totalCost: (c.totalCost / completed.length) * daysInMonth };
  }

  const bySpeed = {};
  for (const k of lastNDays(30)) {
    const d = store.days[k];
    if (!d || !d.bySpeed) continue;
    for (const [rpm, b] of Object.entries(d.bySpeed)) {
      const s = bySpeed[rpm] || (bySpeed[rpm] = { rpm: parseInt(rpm, 10), kWh: 0, seconds: 0 });
      s.kWh += b.kWh;
      s.seconds += b.seconds;
    }
  }

  return {
    rate: store.rate,
    gas: { ...store.gas },
    equipment: store.equipment.map((e) => ({ ...e, perHour: itemPerHour(e) })),
    live,
    today: summarize([today]),
    week: summarize(lastNDays(7)),
    month: { ...month, projected },
    last30: summarize(lastNDays(30)),
    days: lastNDays(14).map((k) => ({ date: k, ...summarize([k]) })),
    bySpeed: Object.values(bySpeed)
      .map((s) => ({ ...s, cost: s.kWh * store.rate, avgWatts: s.seconds ? (s.kWh * 3.6e6) / s.seconds : 0 }))
      .sort((a, b) => b.seconds - a.seconds),
    since: Object.keys(store.days).sort()[0] || null,
  };
}

function validEquipment(list) {
  if (!Array.isArray(list)) throw new Error('Equipment must be a list');
  if (list.length > MAX_EQUIPMENT) throw new Error(`At most ${MAX_EQUIPMENT} equipment items`);
  const seen = new Set();
  return list.map((raw, i) => {
    const where = `Equipment #${i + 1}`;
    const id = String(raw.id || '');
    if (!/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) throw new Error(`${where}: bad or duplicate id`);
    seen.add(id);
    const name = String(raw.name || '').trim().slice(0, 40);
    const category = CATEGORIES.includes(raw.category) ? raw.category : inferCategory({ ...raw, name });
    if (!name) throw new Error(`${where}: name is required`);
    const kind = raw.source?.kind;
    if (!['heater', 'circuit', 'feature'].includes(kind)) throw new Error(`${name}: pick what turns it on`);
    const source = { kind };
    if (kind !== 'heater') {
      source.id = parseInt(raw.source.id, 10);
      if (!(source.id > 0)) throw new Error(`${name}: pick a circuit`);
    }
    if (raw.energy === 'gas') {
      const btu = Number(raw.btu);
      if (!(btu >= 1000 && btu <= 2000000)) throw new Error(`${name}: gas rating must be 1,000–2,000,000 BTU/hr`);
      return { id, name, source, energy: 'gas', btu, category };
    }
    const watts = Number(raw.watts);
    if (!(watts > 0 && watts <= 20000)) throw new Error(`${name}: power must be 1–20,000 W`);
    return { id, name, source, energy: 'electric', watts, category };
  });
}

// Update settings. rate: $/kWh; gasRate: $ per gas unit; equipment: full list.
// gasInputBtu (older clients) updates the heater item's rating.
function setSettings({ rate, gasRate, equipment, gasInputBtu } = {}) {
  const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  rate = num(rate); gasRate = num(gasRate); gasInputBtu = num(gasInputBtu);
  if (rate !== undefined && !(rate > 0 && rate <= 5)) throw new Error('Electricity rate must be in dollars per kWh, e.g. 0.1583');
  if (gasRate !== undefined && !(gasRate > 0 && gasRate <= 50)) throw new Error(`Gas rate must be in dollars per ${store.gas.unit}, e.g. 2.97`);
  const eq = equipment !== undefined ? validEquipment(equipment) : undefined;
  if (gasInputBtu !== undefined && !(gasInputBtu >= 1000 && gasInputBtu <= 2000000)) throw new Error('Heater input must be in BTU/hr, e.g. 264000');
  if (rate !== undefined) store.rate = rate;
  if (gasRate !== undefined) store.gas.rate = gasRate;
  if (eq !== undefined) store.equipment = eq;
  if (gasInputBtu !== undefined) {
    const h = store.equipment.find((e) => e.source?.kind === 'heater');
    if (h) h.btu = gasInputBtu;
  }
  // Credit time up to now under the old list, then keep running state only for items that still exist.
  if (last) {
    const now = Date.now();
    if (now - last.at <= MAX_GAP_MS) accumulate(last.at, now, last);
    const ids = new Set(store.equipment.map((e) => e.id));
    last = { ...last, at: now, on: Object.fromEntries(Object.entries(last.on).filter(([id]) => ids.has(id))) };
  }
  dirty = true;
  save();
}

function setRate(rate) { setSettings({ rate }); }

// Remove whole days from the history (e.g. days recorded while the data was frozen).
// days: ['2026-11-21', ...]. Returns the days actually removed.
function deleteDays(days) {
  if (!Array.isArray(days) || !days.length || days.length > 400) throw new Error('days must be a list of YYYY-MM-DD dates');
  const removed = [];
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Not a date: ${d}`);
    if (store.days[d]) { delete store.days[d]; removed.push(d); }
  }
  // If today was removed, start it fresh from the next reading.
  if (removed.includes(dayKey(Date.now()))) last = null;
  dirty = true;
  save();
  return removed;
}

// Take a new reading now. Background refreshes are throttled to one every 2 s; force (used right
// after equipment was switched) always takes a new one, after any reading already in progress.
async function freshSample(force = false) {
  if (!njspc) return;
  if (sampling) {
    await sampling;
    if (!force) return;
  }
  if (!force && last && Date.now() - last.at < 2000) return;
  sampling = sample(njspc).finally(() => { sampling = null; });
  return sampling;
}

// Usage per day or per month for the analytics page.
// range: '7d' | '30d' | 'month' | '12m'
function history(range = '30d') {
  const now = new Date();
  const day = (y, m, d) => dayKey(new Date(y, m, d).getTime());
  let buckets = [];
  if (range === '12m') {
    for (let i = 11; i >= 0; i--) {
      const first = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const prefix = dayKey(first.getTime()).slice(0, 7);
      buckets.push({ key: prefix, label: first.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
        days: Object.keys(store.days).filter((k) => k.startsWith(prefix)) });
    }
  } else {
    const n = range === '7d' ? 7 : range === 'month' ? now.getDate() : 30;
    const start = range === 'month' ? 1 : now.getDate() - n + 1;
    for (let i = 0; i < n; i++) {
      const k = day(now.getFullYear(), now.getMonth(), start + i);
      buckets.push({ key: k, label: k, days: [k] });
    }
  }
  const allKeys = buckets.flatMap((b) => b.days);
  const total = summarize(allKeys);
  const series = [];
  if (total.pumpKWh > 0) series.push({ id: 'pump-measured', name: 'Pump (measured)', category: 'pump', energy: 'electric' });
  for (const e of store.equipment) series.push({ id: e.id, name: e.name, category: e.category, energy: e.energy });
  const pick = (sum, id) => (id === 'pump-measured'
    ? { cost: sum.pumpCost, seconds: sum.runSeconds, kWh: sum.pumpKWh, gasUnits: 0 }
    : { cost: sum.items[id].cost, seconds: sum.items[id].seconds, kWh: sum.items[id].kWh, gasUnits: sum.items[id].gasUnits });
  const rows = buckets.map((b) => {
    const sum = summarize(b.days);
    return {
      key: b.key, label: b.label, hasData: b.days.some((k) => store.days[k]),
      totalCost: sum.totalCost, elecCost: sum.elecCost, gasCost: sum.gasCost, kWh: sum.kWh, gasUnits: sum.gasUnits,
      values: Object.fromEntries(series.map((s) => [s.id, pick(sum, s.id)])),
    };
  });
  const bySpeed = {};
  for (const k of allKeys) {
    for (const [rpm, b] of Object.entries(store.days[k]?.bySpeed || {})) {
      const x = bySpeed[rpm] || (bySpeed[rpm] = { rpm: parseInt(rpm, 10), kWh: 0, seconds: 0 });
      x.kWh += b.kWh; x.seconds += b.seconds;
    }
  }
  const daysWithData = allKeys.filter((k) => store.days[k]).length;
  return {
    range, group: range === '12m' ? 'month' : 'day', rate: store.rate, gas: { ...store.gas },
    series,
    totals: {
      cost: total.totalCost, elecCost: total.elecCost, gasCost: total.gasCost, kWh: total.kWh, gasUnits: total.gasUnits,
      pumpSeconds: total.runSeconds, daysWithData, perDay: daysWithData ? total.totalCost / daysWithData : 0,
      bySeries: Object.fromEntries(series.map((s) => [s.id, pick(total, s.id)])),
    },
    rows,
    bySpeed: Object.values(bySpeed).map((x) => ({ ...x, cost: x.kWh * store.rate, avgWatts: x.seconds ? (x.kWh * 3.6e6) / x.seconds : 0 }))
      .sort((a, b) => b.seconds - a.seconds),
    since: Object.keys(store.days).sort()[0] || null,
  };
}

function start(njspcUrl) {
  njspc = njspcUrl;
  sample(njspcUrl);
  setInterval(() => sample(njspcUrl), SAMPLE_MS);
  setInterval(() => { prune(); save(); }, SAVE_MS);
  const flush = () => {
    if (last) accumulate(last.at, Date.now(), last);
    last = null;
    save();
    process.exit(0);
  };
  process.on('SIGINT', flush);
  process.on('SIGTERM', flush);
}

module.exports = { start, report, history, freshSample, setRate, setSettings, deleteDays, _test: { accumulate, dayKey, getStore: () => store, summarize, equipmentOn, freshness, sample } };
