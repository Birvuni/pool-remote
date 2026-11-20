// Energy logger: pump electricity and gas-heater usage.
//
// Every SAMPLE_MS it reads nodejs-poolController for:
//   - pump power (watts/RPM/flow) -> kWh
//   - whether the controller is calling for gas heat -> burner hours -> gas used (fixed-input heater)
// and keeps daily totals in data/energy.json.

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
// heatStatus names that mean a gas heater is firing (not solar or a heat pump).
const GAS_HEAT_STATUSES = new Set(['heater', 'mtheater', 'hybheat']);

let store = load();
let last = null; // previous sample: { at, watts, rpm, heating }
let live = { watts: 0, rpm: 0, flow: 0, heating: false, at: null, ok: false, pumps: 0 };
let dirty = false;

function defaultGas() {
  return {
    inputBtu: parseFloat(process.env.GAS_INPUT_BTU || '264000'), // heater input rating, BTU/hr
    btuPerUnit: parseFloat(process.env.GAS_BTU_PER_UNIT || '103700'), // BTU in one billing unit (1 CCF ≈ 103,700 BTU)
    unit: process.env.GAS_UNIT || 'CCF',
    rate: parseFloat(process.env.GAS_RATE || '2.97'), // $ per billing unit
  };
}

function defaultStore() {
  return { version: 2, rate: parseFloat(process.env.ENERGY_RATE || '0.14'), gas: defaultGas(), days: {} };
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (s && typeof s.days === 'object') {
      s.gas = { ...defaultGas(), ...(s.gas || {}) }; // upgrade v1 files
      s.version = 2;
      return s;
    }
  } catch { /* first run or unreadable file */ }
  return defaultStore();
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
  d.heatSeconds ??= 0;
  return d;
}

function prune() {
  const keys = Object.keys(store.days).sort();
  while (keys.length > KEEP_DAYS) delete store.days[keys.shift()];
}

// Add usage for [from, to] with constant pump power and heater state, splitting at midnight.
function accumulate(from, to, watts, rpm, heating = false) {
  let t = from;
  while (t < to) {
    const d = new Date(t);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const end = Math.min(to, midnight);
    const seconds = (end - t) / 1000;
    const kWh = (watts * seconds) / 3.6e6;
    const day = getDay(dayKey(t));
    day.kWh += kWh;
    if (watts > 0) {
      day.runSeconds += seconds;
      day.maxWatts = Math.max(day.maxWatts, watts);
      const bucket = String(Math.round(rpm / RPM_BUCKET) * RPM_BUCKET);
      const b = day.bySpeed[bucket] || (day.bySpeed[bucket] = { kWh: 0, seconds: 0 });
      b.kWh += kWh;
      b.seconds += seconds;
    }
    if (heating) day.heatSeconds += seconds;
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

async function sample(njspcUrl) {
  const now = Date.now();
  try {
    const [pumpList, temps] = await Promise.all([getJson(njspcUrl, '/state/pumps'), getJson(njspcUrl, '/state/temps')]);
    const pumps = (Array.isArray(pumpList) ? pumpList : []).filter((p) => p && p.id);
    let watts = 0, rpm = 0, flow = 0;
    for (const p of pumps) {
      if (typeof p.watts === 'number' && p.watts > 0) watts += p.watts;
      if (typeof p.rpm === 'number') rpm = Math.max(rpm, p.rpm);
      if (typeof p.flow === 'number') flow = Math.max(flow, p.flow);
    }
    const heating = (temps?.bodies || []).some((b) => GAS_HEAT_STATUSES.has((b?.heatStatus?.name || '').toLowerCase()));
    // Values are assumed constant since the previous sample (step integration).
    if (last && now - last.at <= MAX_GAP_MS) accumulate(last.at, now, last.watts, last.rpm, last.heating);
    last = { at: now, watts, rpm, heating };
    live = { watts, rpm, flow, heating, at: new Date(now).toISOString(), ok: true, pumps: pumps.length };
  } catch (err) {
    last = null;
    live = { ...live, ok: false, error: err.message };
  }
}

function gasUnits(heatSeconds) {
  return (store.gas.inputBtu * (heatSeconds / 3600)) / store.gas.btuPerUnit;
}

function summarize(keys) {
  const out = { kWh: 0, runSeconds: 0, heatSeconds: 0 };
  for (const k of keys) {
    const d = store.days[k];
    if (!d) continue;
    out.kWh += d.kWh || 0;
    out.runSeconds += d.runSeconds || 0;
    out.heatSeconds += d.heatSeconds || 0;
  }
  out.cost = out.kWh * store.rate;
  out.gas = gasUnits(out.heatSeconds);
  out.gasCost = out.gas * store.gas.rate;
  out.totalCost = out.cost + out.gasCost;
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
    projected = { cost: (c.cost / completed.length) * daysInMonth, gasCost: (c.gasCost / completed.length) * daysInMonth };
    projected.totalCost = projected.cost + projected.gasCost;
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

  const g = store.gas;
  return {
    rate: store.rate,
    gas: { ...g, unitsPerHour: g.inputBtu / g.btuPerUnit, costPerHour: (g.inputBtu / g.btuPerUnit) * g.rate },
    live,
    today: summarize([today]),
    week: summarize(lastNDays(7)),
    month: { ...month, projected },
    days: lastNDays(14).map((k) => ({ date: k, ...summarize([k]) })),
    bySpeed: Object.values(bySpeed)
      .map((s) => ({ ...s, cost: s.kWh * store.rate, avgWatts: s.seconds ? (s.kWh * 3.6e6) / s.seconds : 0 }))
      .sort((a, b) => b.seconds - a.seconds),
    since: Object.keys(store.days).sort()[0] || null,
  };
}

// Update rates/settings. rate: $/kWh; gasRate: $ per gas unit; gasInputBtu: heater BTU/hr.
function setSettings({ rate, gasRate, gasInputBtu } = {}) {
  const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  rate = num(rate); gasRate = num(gasRate); gasInputBtu = num(gasInputBtu);
  if (rate !== undefined && !(rate > 0 && rate <= 5)) throw new Error('Electricity rate must be in dollars per kWh, e.g. 0.1583');
  if (gasRate !== undefined && !(gasRate > 0 && gasRate <= 50)) throw new Error(`Gas rate must be in dollars per ${store.gas.unit}, e.g. 2.97`);
  if (gasInputBtu !== undefined && !(gasInputBtu >= 10000 && gasInputBtu <= 2000000)) throw new Error('Heater input must be in BTU/hr, e.g. 264000');
  if (rate !== undefined) store.rate = rate;
  if (gasRate !== undefined) store.gas.rate = gasRate;
  if (gasInputBtu !== undefined) store.gas.inputBtu = gasInputBtu;
  dirty = true;
  save();
}

function setRate(rate) { setSettings({ rate }); }

function start(njspcUrl) {
  sample(njspcUrl);
  setInterval(() => sample(njspcUrl), SAMPLE_MS);
  setInterval(() => { prune(); save(); }, SAVE_MS);
  const flush = () => {
    if (last) accumulate(last.at, Date.now(), last.watts, last.rpm, last.heating);
    last = null;
    save();
    process.exit(0);
  };
  process.on('SIGINT', flush);
  process.on('SIGTERM', flush);
}

module.exports = { start, report, setRate, setSettings, _test: { accumulate, dayKey, getStore: () => store, summarize } };
