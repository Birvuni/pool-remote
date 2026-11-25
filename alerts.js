// Cold-weather alerts.
//
// Every CHECK_MS it reads nodejs-poolController (/state/all) and raises alerts for:
//   cold       air temperature at/below the threshold (once; re-arms after it warms up)
//   freeze     the controller's freeze protection turns on / off
//   pumpOff    air at/below the danger level and no water moving (repeats while it lasts)
//   stale      no data from the controller for a while (the panel clock stops advancing)
// Alerts go to the in-app history and, if configured, to the phone through ntfy
// (https://ntfy.sh: free app, no account; the topic name acts as the password).

const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'alerts.json');
const CHECK_MS = parseInt(process.env.ALERTS_INTERVAL_MS || '60000', 10);
const HISTORY_MAX = 50;
const REARM_DEG = 3;                      // cold alert re-arms after air rises this much above threshold
const PUMP_OFF_REPEAT_MS = 30 * 60 * 1000;
const STALE_ALERT_MS = parseInt(process.env.ALERTS_STALE_MS || String(10 * 60 * 1000), 10);
const SPEED_TYPES = ['vs', 'vssvrs', 'vsf', 'vf'];

let njspc = null;
let settings = null;
let history = [];
let status = { ok: false };
// Alert state (in memory; after a restart an active condition is reported once more).
const flags = { cold: false, freeze: null, pumpOffAt: 0, staleAlerted: false, panelTime: null, panelChangedAt: 0 };

function defaults() {
  return {
    notify: { enabled: false, server: 'https://ntfy.sh', topic: '' },
    airThreshold: 38, // in the controller's units (°F by default)
    rules: { cold: true, freeze: true, pumpOff: true, stale: true },
  };
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const d = defaults();
    settings = { ...d, ...s.settings, notify: { ...d.notify, ...(s.settings?.notify || {}) }, rules: { ...d.rules, ...(s.settings?.rules || {}) } };
    history = Array.isArray(s.history) ? s.history.slice(0, HISTORY_MAX) : [];
  } catch {
    settings = defaults();
    history = [];
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ settings, history }));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('alerts: save failed:', err.message);
  }
}

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: njspc.hostname, port: njspc.port || 80, path: urlPath, timeout: 10000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Send to the phone through ntfy. Resolves to { sent, error }.
async function deliver(alert) {
  const n = settings.notify;
  if (!n.enabled || !n.topic) return { sent: false, error: 'notifications off' };
  try {
    const url = `${n.server.replace(/\/+$/, '')}/${encodeURIComponent(n.topic)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Title: alert.title,
        Priority: String(alert.priority || 3),
        Tags: (alert.tags || []).join(','),
      },
      body: alert.message,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { sent: false, error: `ntfy answered ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

async function raise(kind, title, message, { priority = 3, tags = [] } = {}) {
  const alert = { at: new Date().toISOString(), kind, title, message, priority, tags };
  const r = await deliver(alert);
  alert.sent = r.sent;
  if (r.error && settings.notify.enabled) alert.error = r.error;
  history.unshift(alert);
  history = history.slice(0, HISTORY_MAX);
  save();
  return alert;
}

function parsePanelTime(s) {
  if (typeof s !== 'string' || !s) return null;
  const t = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(t) ? t : null;
}

// Is water moving? Any body (pool/spa) on, a variable-speed pump turning, or freeze protection on.
function waterMoving(state) {
  if ((state.temps?.bodies || []).some((b) => b.isOn)) return true;
  if (state.freeze) return true;
  return (state.pumps || []).some((p) => SPEED_TYPES.includes((p.type?.name || '').toLowerCase()) && p.rpm > 0);
}

async function check() {
  if (!njspc) return;
  const now = Date.now();
  let state;
  try {
    state = await getJson('/state/all');
  } catch (err) {
    status = { ok: false, error: `Can't reach poolController: ${err.message}`, at: new Date(now).toISOString() };
    return;
  }
  const unitC = state.temps?.units?.name === 'C';
  const u = unitC ? '°C' : '°F';
  const air = typeof state.temps?.air === 'number' ? state.temps.air : null;
  const danger = unitC ? 1 : 34;

  // Stale data: panel clock not advancing (same idea as the energy logger).
  const raw = state.time || '';
  if (raw !== flags.panelTime) { flags.panelTime = raw; flags.panelChangedAt = now; }
  const panelMs = parsePanelTime(raw);
  const stale = !raw || now - flags.panelChangedAt > STALE_ALERT_MS || (panelMs !== null && now - panelMs > 2 * 3600 * 1000);
  const moving = waterMoving(state);
  status = { ok: true, at: new Date(now).toISOString(), air, unit: u, freeze: !!state.freeze, moving, stale,
    threshold: settings.airThreshold, danger, cold: air !== null && air <= settings.airThreshold };

  if (stale) {
    if (settings.rules.stale && !flags.staleAlerted) {
      flags.staleAlerted = true;
      const since = panelMs ? new Date(panelMs).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'a while';
      await raise('stale', 'Pool: no data from the controller',
        `poolController hasn't had an update from the controller since ${since}, so cold-weather alerts can't be trusted. Fix: pm2 restart poolController on the Pi.`,
        { priority: 4, tags: ['warning'] });
    }
    return; // Everything else would be based on frozen data.
  }
  if (flags.staleAlerted) {
    flags.staleAlerted = false;
    if (settings.rules.stale) await raise('stale', 'Pool: data is updating again', 'poolController is receiving updates from the controller again.', { priority: 2, tags: ['white_check_mark'] });
  }
  if (air === null) return;

  // Cold weather.
  if (!flags.cold && air <= settings.airThreshold) {
    flags.cold = true;
    if (settings.rules.cold) {
      await raise('cold', `Pool: cold weather, air ${Math.round(air)}${u}`,
        `Air is ${Math.round(air)}${u}. The controller's freeze protection starts on its own near ${unitC ? '2°C' : '36°F'} and runs the circuits marked for freeze protection.`,
        { priority: 3, tags: ['snowflake'] });
    }
  } else if (flags.cold && air >= settings.airThreshold + REARM_DEG) {
    flags.cold = false;
  }

  // Freeze protection on/off (first reading only sets the baseline, except "already on").
  const fz = !!state.freeze;
  if (flags.freeze === null) {
    flags.freeze = fz;
    if (fz && settings.rules.freeze) await raise('freeze', 'Pool: freeze protection is running', `Freeze protection is on (air ${Math.round(air)}${u}); the pump keeps water moving.`, { priority: 3, tags: ['shield'] });
  } else if (fz !== flags.freeze) {
    flags.freeze = fz;
    if (settings.rules.freeze) {
      await raise('freeze', fz ? 'Pool: freeze protection started' : 'Pool: freeze protection ended',
        fz ? `Air is ${Math.round(air)}${u}. The controller turned on freeze protection; the pump keeps water moving.`
          : `Air is ${Math.round(air)}${u}. Freeze protection turned off; equipment is back to normal.`,
        { priority: fz ? 3 : 2, tags: [fz ? 'shield' : 'sunny'] });
    }
  }

  // Danger: freezing air and no water moving.
  if (air <= danger && !moving) {
    if (settings.rules.pumpOff && now - flags.pumpOffAt >= PUMP_OFF_REPEAT_MS) {
      flags.pumpOffAt = now;
      await raise('pumpOff', `Pool: PUMP NOT RUNNING, air ${Math.round(air)}${u}`,
        `Air is ${Math.round(air)}${u} and no water is moving. Pipes and equipment can freeze. Turn on Pool mode now and check the controller's freeze protection.`,
        { priority: 5, tags: ['rotating_light'] });
    }
  } else {
    flags.pumpOffAt = 0;
  }
}

function report() {
  return { settings, status, history: history.slice(0, 20) };
}

function setSettings(body = {}) {
  const next = JSON.parse(JSON.stringify(settings));
  if (body.notify) {
    if (typeof body.notify.enabled === 'boolean') next.notify.enabled = body.notify.enabled;
    if (typeof body.notify.topic === 'string') {
      const t = body.notify.topic.trim();
      if (t && !/^[A-Za-z0-9_-]{6,64}$/.test(t)) throw new Error('Topic: 6–64 letters, numbers, - or _');
      next.notify.topic = t;
    }
    if (typeof body.notify.server === 'string') {
      const s = body.notify.server.trim() || 'https://ntfy.sh';
      if (!/^https?:\/\/[^\s/]+/.test(s)) throw new Error('Server must start with https://');
      next.notify.server = s;
    }
    if (next.notify.enabled && !next.notify.topic) throw new Error('Pick a topic name before turning notifications on');
  }
  if (body.airThreshold !== undefined) {
    const v = Number(body.airThreshold);
    if (!Number.isFinite(v) || v < -20 || v > 60) throw new Error('Air threshold must be between -20 and 60 degrees');
    next.airThreshold = v;
    flags.cold = false; // re-evaluate against the new threshold
  }
  if (body.rules) for (const k of Object.keys(next.rules)) if (typeof body.rules[k] === 'boolean') next.rules[k] = body.rules[k];
  settings = next;
  save();
  return report();
}

async function test() {
  if (!settings.notify.enabled || !settings.notify.topic) throw new Error('Turn notifications on and set a topic first');
  const a = await raise('test', 'Pool: test notification', 'If you can read this on your phone, pool alerts are working.', { priority: 3, tags: ['bell'] });
  if (!a.sent) throw new Error(`Not delivered: ${a.error || 'unknown error'}`);
  return a;
}

function start(njspcUrl) {
  njspc = njspcUrl;
  load();
  setTimeout(() => check().catch((e) => console.error('alerts:', e.message)), 5000);
  setInterval(() => check().catch((e) => console.error('alerts:', e.message)), CHECK_MS);
}

module.exports = { start, report, setSettings, test, _test: { check, flags, waterMoving, getSettings: () => settings, load } };
