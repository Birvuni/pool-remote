// Bus check: is a Pentair pump talking on the RS-485 bus, and what does the controller
// report about its pump setup?
//
// Usage (on the Pi, with poolController running under pm2):
//   node dev/bus-check.js [seconds] [path-to-poolController-out.log]
//
// It briefly turns on poolController's packet logging, records the bus for N seconds (default 120), restores the logging
// settings, and summarizes what it saw. Run it with the pump running (Pool mode on).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SECONDS = parseInt(process.argv[2] || '120', 10);
const LOG = process.argv[3] || path.join(os.homedir(), '.pm2', 'logs', 'poolController-out.log');
const NJSPC = { hostname: '127.0.0.1', port: 4200 };

const ADDR = { 15: 'broadcast', 16: 'EasyTouch', 33: 'remote/Pi', 34: 'wireless', 32: 'indoor panel' };
const name = (a) => (a >= 96 && a <= 111 ? `pump ${a - 95} (addr ${a})` : ADDR[a] || `addr ${a}`);

function call(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ ...NJSPC, path: urlPath, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(LOG)) {
    console.error(`Can't find the poolController log at ${LOG}. Pass its path as the 2nd argument.`);
    process.exit(1);
  }
  const before = await call('GET', '/app/options/logger');
  const prev = { enabled: !!before?.packet?.enabled, logToConsole: !!before?.packet?.logToConsole };
  const startSize = fs.statSync(LOG).size;

  console.log(`Recording the bus for ${SECONDS} s… (keep the pump running)`);
  await call('PUT', '/app/logger/setOptions', { packet: { enabled: true, logToConsole: true } });
  // Note: no /app/config/reload here. On EasyTouch (unpatched poolController) it freezes all status
  // updates until poolController restarts.
  try {
    for (let s = SECONDS; s > 0; s -= 10) {
      process.stdout.write(`  ${s} s left\r`);
      await wait(Math.min(10, s) * 1000);
    }
  } finally {
    await call('PUT', '/app/logger/setOptions', { packet: prev });
  }
  console.log('Done. Logging settings restored.          \n');

  const fd = fs.openSync(LOG, 'r');
  const len = fs.statSync(LOG).size - startSize;
  const buf = Buffer.alloc(Math.max(0, len));
  fs.readSync(fd, buf, 0, buf.length, startSize);
  fs.closeSync(fd);

  const packets = [];
  for (const line of buf.toString('utf8').split('\n')) {
    const i = line.indexOf('{"port"');
    if (i < 0) continue;
    try {
      const m = JSON.parse(line.slice(i));
      const [, , header, payload] = m.pkt;
      if (!Array.isArray(header) || header.length < 6 || header[0] !== 165) continue;
      packets.push({ dest: header[2], src: header[3], action: header[4], payload, dir: m.dir, valid: m.valid });
    } catch { /* not a packet line */ }
  }

  console.log(`Captured ${packets.length} Pentair packets.`);
  if (!packets.length) {
    console.log('No packets captured. Is poolController running and connected (green status in the app)?');
    return;
  }

  // Who is talking?
  const talkers = {};
  for (const p of packets) {
    const k = `${name(p.src)} -> ${name(p.dest)}`;
    talkers[k] = (talkers[k] || 0) + 1;
  }
  console.log('\nTraffic seen:');
  for (const [k, n] of Object.entries(talkers).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

  // Pump traffic (addresses 96-111).
  const pumpPkts = packets.filter((p) => (p.src >= 96 && p.src <= 111) || (p.dest >= 96 && p.dest <= 111));
  const fromPump = pumpPkts.filter((p) => p.src >= 96 && p.src <= 111);
  console.log('\nPUMP ON THE BUS:');
  if (!pumpPkts.length) {
    console.log('  No traffic to or from any pump address. The EasyTouch is not talking to an IntelliFlo,');
    console.log('  so the pump is not connected to the bus (or is set to a different address).');
  } else if (!fromPump.length) {
    console.log(`  The controller sent ${pumpPkts.length} messages to a pump, but no pump answered.`);
    console.log('  Check the pump data cable (yellow/green) and the pump address (should be 1).');
  } else {
    const status = fromPump.filter((p) => p.action === 7 && p.payload.length >= 7);
    console.log(`  YES — ${fromPump.length} replies from ${[...new Set(fromPump.map((p) => name(p.src)))].join(', ')}.`);
    const last = status[status.length - 1];
    if (last) {
      const watts = last.payload[3] * 256 + last.payload[4];
      const rpm = last.payload[5] * 256 + last.payload[6];
      console.log(`  Latest pump status: ${rpm} RPM, ${watts} W`);
    }
  }

  // What the EasyTouch says about pump setup (config replies, action 24/27).
  const cfg = packets.filter((p) => p.src === 16 && (p.action === 24 || p.action === 27) && p.payload.length > 1);
  console.log('\nPUMP SETUP REPORTED BY THE EASYTOUCH:');
  if (!cfg.length) {
    console.log('  No pump-setup replies captured. poolController asks for them at startup: run');
    console.log('  "pm2 restart poolController", then right away: node dev/bus-check.js 240');
  } else {
    const types = { 0: 'none', 64: 'IntelliFlo VSF', 128: 'IntelliFlo VS', 134: 'IntelliFlo VS Ultra', 169: 'IntelliFlo VS+SVRS', 255: 'IntelliFlo VS (old panel)' };
    const seen = new Map();
    for (const p of cfg) seen.set(p.payload[0], p.payload[1]);
    for (const [slot, type] of [...seen].sort((a, b) => a[0] - b[0])) {
      console.log(`  Pump slot ${slot}: ${types[type] ?? `IntelliFlo VF / other (type ${type})`}`);
    }
  }
  console.log('\nSend a screenshot of this output.');
})().catch((err) => {
  console.error('Bus check failed:', err.message);
  process.exit(1);
});
