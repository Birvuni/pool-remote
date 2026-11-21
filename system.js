// Raspberry Pi health: CPU, temperature, memory, disk, Wi-Fi, uptime and power/throttling flags.
// Everything degrades gracefully: on a machine without a value (e.g. no Wi-Fi) it is null.

const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

let cpuPrev = null;
let cpuPct = null;
let throttle = { value: null, at: 0 };

function sampleCpu() {
  const t = os.cpus().reduce((acc, c) => {
    const total = Object.values(c.times).reduce((a, b) => a + b, 0);
    acc.total += total;
    acc.idle += c.times.idle;
    return acc;
  }, { total: 0, idle: 0 });
  if (cpuPrev) {
    const dt = t.total - cpuPrev.total;
    cpuPct = dt > 0 ? Math.max(0, Math.min(100, (1 - (t.idle - cpuPrev.idle) / dt) * 100)) : cpuPct;
  }
  cpuPrev = t;
}

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function memory() {
  const txt = read('/proc/meminfo');
  if (txt) {
    const kb = (k) => parseInt((txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1], 10);
    const total = kb('MemTotal'), avail = kb('MemAvailable');
    if (total && avail >= 0) return { totalMB: Math.round(total / 1024), usedMB: Math.round((total - avail) / 1024), pct: ((total - avail) / total) * 100 };
  }
  const total = os.totalmem(), free = os.freemem();
  return { totalMB: Math.round(total / 1048576), usedMB: Math.round((total - free) / 1048576), pct: ((total - free) / total) * 100 };
}

function temperatureC() {
  const v = parseInt(read('/sys/class/thermal/thermal_zone0/temp'), 10);
  return Number.isFinite(v) ? v / 1000 : null;
}

function disk() {
  try {
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { totalGB: total / 1e9, freeGB: free / 1e9, pct: ((total - free) / total) * 100 };
  } catch { return null; }
}

// /proc/net/wireless: "wlan0: 0000   54.  -56.  -256 ..." -> link quality /70, signal dBm.
function wifi() {
  const txt = read('/proc/net/wireless');
  if (!txt) return null;
  const line = txt.split('\n').find((l) => /^\s*wl\w*:/.test(l));
  if (!line) return null;
  const parts = line.trim().split(/\s+/);
  const quality = parseFloat(parts[2]);
  const dbm = parseFloat(parts[3]);
  if (!Number.isFinite(dbm)) return null;
  return { iface: parts[0].replace(':', ''), dbm, qualityPct: Number.isFinite(quality) ? Math.round((quality / 70) * 100) : null };
}

// vcgencmd get_throttled -> bit flags. Cached for 30 s; absent on non-Pi machines.
function refreshThrottle() {
  if (Date.now() - throttle.at < 30000) return;
  throttle.at = Date.now();
  execFile('vcgencmd', ['get_throttled'], { timeout: 2000 }, (err, out) => {
    if (err) { throttle.value = null; return; }
    const m = /throttled=(0x[0-9a-f]+)/i.exec(out || '');
    throttle.value = m ? parseInt(m[1], 16) : null;
  });
}

function power() {
  const v = throttle.value;
  if (v === null) return null;
  return {
    raw: '0x' + v.toString(16),
    underVoltageNow: !!(v & 0x1),
    throttledNow: !!(v & 0x4) || !!(v & 0x2),
    tempLimitNow: !!(v & 0x8),
    underVoltageSinceBoot: !!(v & 0x10000),
    throttledSinceBoot: !!(v & 0x40000) || !!(v & 0x20000),
  };
}

function model() {
  const m = read('/proc/device-tree/model');
  return m ? m.replace(/\0/g, '').trim() : `${os.type()} ${os.arch()}`;
}

function report() {
  refreshThrottle();
  return {
    hostname: os.hostname(),
    model: model(),
    cpuPct,
    cores: os.cpus().length,
    load: os.loadavg(),
    tempC: temperatureC(),
    memory: memory(),
    disk: disk(),
    wifi: wifi(),
    power: power(),
    uptimeSec: os.uptime(),
    appUptimeSec: process.uptime(),
    at: new Date().toISOString(),
  };
}

function start() {
  sampleCpu();
  setInterval(sampleCpu, 5000).unref();
  refreshThrottle();
}

module.exports = { start, report };
