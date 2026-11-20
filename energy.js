// Pump energy logger.
// Samples pump watts/RPM from nodejs-poolController and keeps daily totals in data/energy.json.

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

let store = load();
let last = null; // { at, watts, rpm, flow }
let live = { watts: 0, rpm: 0, flow: 0, at: null, ok: false, pumps: 0 };
let dirty = false;

function defaultStore() {
  const rate = parseFloat(process.env.ENERGY_RATE || '0.14');
  return { version: 1, rate, days: {} };
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (s && typeof s.days === 'object') return s;
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
  if (!store.days[key]) store.days[key] = { kWh: 0, runSeconds: 0, maxWatts: 0, bySpeed: {} };
  return store.days[key];
}

function prune() {
  const keys = Object.keys(store.days).sort();
  while (keys.length > KEEP_DAYS) delete store.days[keys.shift()];
}

// Add energy for the interval [from, to] at a constant power, splitting across midnight.
function accumulate(from, to, watts, rpm) {
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
    t = end;
  }
  dirty = true;
}

function fetchPumps(njspcUrl) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: njspcUrl.hostname, port: njspcUrl.port || 80, path: '/state/pumps', timeout: 10000 },
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
    const pumps = (await fetchPumps(njspcUrl)).filter((p) => p && p.id);
    let watts = 0, rpm = 0, flow = 0;
    for (const p of pumps) {
      if (typeof p.watts === 'number' && p.watts > 0) watts += p.watts;
      if (typeof p.rpm === 'number') rpm = Math.max(rpm, p.rpm);
      if (typeof p.flow === 'number') flow = Math.max(flow, p.flow);
    }
    // Power is assumed constant since the previous sample (step integration).
    if (last && now - last.at <= MAX_GAP_MS) accumulate(last.at, now, last.watts, last.rpm);
    last = { at: now, watts, rpm, flow };
    live = { watts, rpm, flow, at: new Date(now).toISOString(), ok: true, pumps: pumps.length };
  } catch (err) {
    last = null;
    live = { ...live, ok: false, error: err.message };
  }
}

function summarize(keys) {
  const out = { kWh: 0, runSeconds: 0 };
  for (const k of keys) {
    const d = store.days[k];
    if (!d) continue;
    out.kWh += d.kWh;
    out.runSeconds += d.runSeconds;
  }
  out.cost = out.kWh * store.rate;
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
  const avgPerDay = completed.length ? summarize(completed).kWh / completed.length : null;

  const bySpeed = {};
  for (const k of lastNDays(30)) {
    const d = store.days[k];
    if (!d) continue;
    for (const [rpm, b] of Object.entries(d.bySpeed)) {
      const s = bySpeed[rpm] || (bySpeed[rpm] = { rpm: parseInt(rpm, 10), kWh: 0, seconds: 0 });
      s.kWh += b.kWh;
      s.seconds += b.seconds;
    }
  }

  return {
    rate: store.rate,
    live,
    today: summarize([today]),
    week: summarize(lastNDays(7)),
    // Full-month projection at the pace of the completed days logged so far.
    month: { ...month, projectedKWh: avgPerDay === null ? null : avgPerDay * daysInMonth },
    days: lastNDays(14).map((k) => ({ date: k, ...summarize([k]) })),
    bySpeed: Object.values(bySpeed)
      .map((s) => ({ ...s, cost: s.kWh * store.rate, avgWatts: s.seconds ? (s.kWh * 3.6e6) / s.seconds : 0 }))
      .sort((a, b) => b.seconds - a.seconds),
    since: Object.keys(store.days).sort()[0] || null,
  };
}

function setRate(rate) {
  if (typeof rate !== 'number' || !(rate > 0) || rate > 5) throw new Error('Rate must be in dollars per kWh, e.g. 0.1583');
  store.rate = rate;
  dirty = true;
  save();
}

function start(njspcUrl) {
  sample(njspcUrl);
  setInterval(() => sample(njspcUrl), SAMPLE_MS);
  setInterval(() => { prune(); save(); }, SAVE_MS);
  const flush = () => {
    if (last) accumulate(last.at, Date.now(), last.watts, last.rpm);
    last = null;
    save();
    process.exit(0);
  };
  process.on('SIGINT', flush);
  process.on('SIGTERM', flush);
}

module.exports = { start, report, setRate, _test: { accumulate, dayKey, getStore: () => store } };
