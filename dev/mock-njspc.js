const fs = require('fs');
// A tiny fake nodejs-poolController for developing Pool Remote without real hardware.
// Mimics an EasyTouch with a shared pool/spa body. Run: node dev/mock-njspc.js (port 4200)

const http = require('http');

const PORT = parseInt(process.env.PORT || '4200', 10);

const circuitTypes = {
  generic: { val: 0, name: 'generic', desc: 'Generic' },
  spa: { val: 1, name: 'spa', desc: 'Spa' },
  pool: { val: 2, name: 'pool', desc: 'Pool' },
  intellibrite: { val: 16, name: 'intellibrite', desc: 'Intellibrite', isLight: true },
  light: { val: 7, name: 'light', desc: 'Light', isLight: true },
  notused: { val: 19, name: 'notused', desc: 'Not Used' },
};

const days = [
  { val: 1, name: 'sun', desc: 'Sunday', dow: 0 },
  { val: 2, name: 'mon', desc: 'Monday', dow: 1 },
  { val: 4, name: 'tue', desc: 'Tuesday', dow: 2 },
  { val: 8, name: 'wed', desc: 'Wednesday', dow: 3 },
  { val: 16, name: 'thu', desc: 'Thursday', dow: 4 },
  { val: 32, name: 'fri', desc: 'Friday', dow: 5 },
  { val: 64, name: 'sat', desc: 'Saturday', dow: 6 },
];
const transformDays = (bits) => ({ val: bits, days: days.filter((d) => bits & d.val) });
const heatModes = [{ val: 0, name: 'off', desc: 'Off' }, { val: 1, name: 'heater', desc: 'Heater' }];
const timeTypes = [{ val: 0, name: 'manual', desc: 'Manual' }, { val: 1, name: 'sunrise', desc: 'Sunrise' }, { val: 2, name: 'sunset', desc: 'Sunset' }];
const schedTypes = [{ val: 0, name: 'repeat', desc: 'Repeats' }, { val: 26, name: 'runonce', desc: 'Run Once' }];

// Mirrors the real EasyTouch2 4 this was built for.
const circuits = [
  { id: 1, name: 'Spa', isOn: false, type: circuitTypes.spa },
  { id: 2, name: 'Lights', isOn: false, type: circuitTypes.intellibrite },
  { id: 3, name: 'Air Blower', isOn: false, type: circuitTypes.generic },
  { id: 4, name: 'Water Feature', isOn: false, type: circuitTypes.generic },
  { id: 5, name: 'AUX 4', isOn: false, type: circuitTypes.generic },
  { id: 6, name: 'Pool', isOn: true, type: circuitTypes.pool },
  { id: 7, name: 'Floor Cleaner', isOn: false, type: circuitTypes.generic },
];
const features = [{ id: 11, name: 'Fountain', isOn: false, type: { val: 0, name: 'generic', desc: 'Generic' } }];
const featureById = (id) => features.find((f) => f.id === id);
// MOCK_INTELLIFLO=1 simulates a pump that reports watts/RPM; otherwise a relay-only "Two Speed" pump.
const INTELLIFLO = process.env.MOCK_INTELLIFLO === '1';

const bodies = [
  { id: 1, name: 'Pool', circuit: 6, temp: 78, setPoint: 82, isOn: true, type: { val: 0, name: 'pool', desc: 'Pool' }, heatMode: heatModes[0], heatStatus: { val: 0, name: 'off', desc: 'Off' } },
  { id: 2, name: 'Spa', circuit: 1, temp: 77, setPoint: 100, isOn: false, type: { val: 1, name: 'spa', desc: 'Spa' }, heatMode: heatModes[1], heatStatus: { val: 0, name: 'off', desc: 'Off' } },
];

let schedules = [
  { id: 1, circuit: 6, startTime: 630, endTime: 960, scheduleDays: transformDays(127), scheduleType: schedTypes[0], startTimeType: timeTypes[0], endTimeType: timeTypes[0], isOn: false, disabled: false },
  { id: 2, circuit: 7, startTime: 539, endTime: 960, scheduleDays: transformDays(127), scheduleType: schedTypes[0], startTimeType: timeTypes[0], endTimeType: timeTypes[0], isOn: false, disabled: false },
];

const circuitById = (id) => circuits.find((c) => c.id === id);
// PUT /mock/weather {air, freeze}: change air temperature / freeze protection for testing alerts.
const weather = { air: 64, freeze: false };
// IntelliBrite: the EasyTouch's light group 192 ("Intellibrite") holds the IntelliBrite circuits.
const LIGHT_THEMES = { off: 0, on: 1, party: 177, romance: 178, caribbean: 179, american: 180, sunset: 181, royal: 182,
  blue: 193, green: 194, red: 195, white: 196, magenta: 197 };
const themeDesc = { sunset: 'California Sunset' };
const lightGroup = { id: 192, name: 'Intellibrite', isActive: true, lightingTheme: { val: 177, name: 'party', desc: 'Party' } };
// MOCK_SWITCH_DELAY_MS: pool/spa changes take effect after this delay (valves and pump are slow).
const SWITCH_DELAY = parseInt(process.env.MOCK_SWITCH_DELAY_MS || '0', 10);

function syncBodies() {
  for (const b of bodies) {
    b.isOn = !!circuitById(b.circuit)?.isOn;
    const heating = b.isOn && b.heatMode.name !== 'off' && b.temp < b.setPoint;
    b.heatStatus = heating ? { val: 1, name: 'heater', desc: 'Heater' } : { val: 0, name: 'off', desc: 'Off' };
  }
}

const config = require('./mock-config')({ circuits, features, circuitTypes, bodies, days });

function setCircuit(id, isOn) {
  const c = circuitById(id);
  if (!c) throw Object.assign(new Error(`Invalid circuit id ${id}`), { status: 400 });
  if (SWITCH_DELAY && (id === 1 || id === 6)) {
    setTimeout(() => applyCircuit(c, id, isOn), SWITCH_DELAY);
    return c;
  }
  return applyCircuit(c, id, isOn);
}

function applyCircuit(c, id, isOn) {
  c.isOn = isOn;
  // EasyTouch shared body: pool and spa are mutually exclusive.
  if (isOn && (id === 1 || id === 6)) circuitById(id === 1 ? 6 : 1).isOn = false;
  syncBodies();
  return c;
}

// An IntelliFlo VS (power rises roughly with RPM cubed).
function pumps() {
  // RPM follows the EasyTouch speed settings (highest speed among circuits that are on).
  const rpm = config.vsSpeed();
  const watts = rpm ? Math.round(2950 * Math.pow(rpm / 3450, 3) + 40) : 0;
  const flow = rpm ? Math.round(rpm / 40) : 0;
  // Like the real system: the EasyTouch's relay-only "Two Speed" entry (id 10) is always present,
  // and the IntelliFlo shows up as pump 2 (once poolController is patched).
  const twoSpeed = { id: 10, name: 'Two Speed', type: { val: 65, name: 'ds', desc: 'Two-Speed' } };
  if (!INTELLIFLO) return [twoSpeed];
  const vs = { id: config.vsPump.id, name: 'Intelliflo VS', type: { val: 128, name: 'vs', desc: 'Intelliflo VS' } };
  // Like the real poolController: no RPM/watts fields while the pump is off.
  return [twoSpeed, rpm ? { ...vs, rpm, watts, flow } : vs];
}

function stateAll() {
  syncBodies();
  return {
    alias: 'Backyard Pool',
    controllerType: 'easytouch',
    model: 'EasyTouch2 4',
    status: { val: 1, name: 'ready', desc: 'Ready', percent: 100 },
    appVersion: 'mock',
    time: config.panelTime(),
    freeze: weather.freeze,
    temps: { air: weather.air, units: { val: 0, name: 'F', desc: 'Fahrenheit' }, bodies },
    equipment: { model: 'EasyTouch2 4', controllerType: 'easytouch' },
    circuits,
    features,
    lightGroups: [{ ...lightGroup, isOn: !!circuitById(2)?.isOn }],
    pumps: pumps(),
    schedules: schedules.map((s) => ({ ...s, circuit: circuitById(s.circuit) })),
  };
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Fake packet log (for dev/bus-check.js). When packet logging is on, writes poolController-style
// packet lines to MOCK_LOG every 2 s: pump traffic only if MOCK_INTELLIFLO=1.
const MOCK_LOG = process.env.MOCK_LOG;
let packetLogging = false;
function pktLine(header, payload) {
  const ts = new Date().toISOString();
  return `${ts} info: {"port":0,"id":1,"valid":true,"dir":"in","proto":"broadcast","pkt":[[],[255,0,255],${JSON.stringify(header)},${JSON.stringify(payload)},[1,0]],"ts":"${ts}"}\n`;
}
setInterval(() => {
  if (!packetLogging || !MOCK_LOG) return;
  let out = pktLine([165, 1, 15, 16, 2, 29], new Array(29).fill(0));
  if (INTELLIFLO) {
    const p = pumps().find((x) => typeof x.watts === 'number');
    out += pktLine([165, 0, 96, 16, 1, 4], [2, 196, 7, 8]);
    out += pktLine([165, 0, 16, 96, 7, 15], [10, 2, 2, p.watts >> 8, p.watts & 255, p.rpm >> 8, p.rpm & 255, 0, 0, 0, 0, 0, 1, 2, 3]);
  }
  out += pktLine([165, 1, 15, 16, 24, 31], [1, INTELLIFLO ? 169 : 0].concat(new Array(29).fill(0)));
  fs.appendFileSync(MOCK_LOG, out);
}, 2000);

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { message: 'Bad JSON' }); }
    const url = req.url.split('?')[0];
    const key = `${req.method} ${url}`;
    console.log(key, raw);
    try {
      if (key === 'GET /state/all') return send(res, 200, stateAll());
      if (key === 'PUT /state/circuit/setTheme') {
        if (parseInt(body.id, 10) !== lightGroup.id) return send(res, 400, { message: `mock: setTheme only for light group ${lightGroup.id}` });
        const name = String(body.theme).toLowerCase();
        if (!(name in LIGHT_THEMES)) return send(res, 400, { message: `Invalid theme ${body.theme}` });
        lightGroup.lightingTheme = { val: LIGHT_THEMES[name], name, desc: themeDesc[name] || name[0].toUpperCase() + name.slice(1) };
        circuitById(2).isOn = name !== 'off';
        return send(res, 200, { ...lightGroup, isOn: circuitById(2).isOn });
      }
      if (key === 'PUT /mock/weather') {
        if (typeof body.air === 'number') weather.air = body.air;
        if (typeof body.freeze === 'boolean') weather.freeze = body.freeze;
        return send(res, 200, weather);
      }
      const cfg = config.handle(key, body);
      if (cfg !== undefined) return send(res, 200, cfg);
      if (key === 'GET /app/options/logger') return send(res, 200, { packet: { enabled: packetLogging, logToConsole: packetLogging } });
      if (key === 'PUT /app/logger/setOptions') { packetLogging = !!body?.packet?.logToConsole; return send(res, 200, {}); }
      if (key === 'PUT /app/config/reload') return send(res, 200, {});
      if (key === 'GET /state/pumps') return send(res, 200, pumps());
      if (key === 'GET /state/temps') { syncBodies(); return send(res, 200, { bodies }); }
      if (key === 'PUT /state/circuit/setState') return send(res, 200, setCircuit(parseInt(body.id, 10), !!body.isOn));
      if (key === 'PUT /state/feature/setState') {
        const ft = featureById(parseInt(body.id, 10));
        if (!ft) return send(res, 400, { message: `Invalid feature id ${body.id}` });
        ft.isOn = !!body.isOn;
        return send(res, 200, ft);
      }
      if (key === 'PUT /state/body/setPoint') {
        const b = bodies.find((x) => x.id === parseInt(body.id, 10));
        b.setPoint = parseInt(body.setPoint, 10);
        syncBodies();
        return send(res, 200, b);
      }
      if (key === 'PUT /state/body/heatMode') {
        const b = bodies.find((x) => x.id === parseInt(body.id, 10));
        b.heatMode = heatModes.find((m) => m.name === body.mode) || heatModes[0];
        syncBodies();
        return send(res, 200, b);
      }
      let m = url.match(/^\/config\/body\/(\d+)\/heatModes$/);
      if (req.method === 'GET' && m) return send(res, 200, heatModes);
      if (key === 'GET /config/options/schedules') {
        return send(res, 200, {
          scheduleDays: days.map((d) => ({ ...d, bitval: d.val })),
          scheduleTypes: schedTypes,
          scheduleTimeTypes: timeTypes,
          circuits: circuits.filter((c) => c.type.name !== 'notused').map((c) => ({ id: c.id, name: c.name })).concat(features.map((x) => ({ id: x.id, name: x.name }))),
        });
      }
      if (key === 'PUT /config/schedule') {
        let id = parseInt(body.id, 10);
        if (!id) id = Math.max(0, ...schedules.map((s) => s.id)) + 1;
        const existing = schedules.find((s) => s.id === id);
        const s = existing || { id, isOn: false, disabled: false };
        s.circuit = parseInt(body.circuit, 10);
        s.startTime = body.startTime;
        s.endTime = body.endTime;
        s.scheduleDays = transformDays(body.scheduleDays);
        s.scheduleType = schedTypes.find((t) => t.val === body.scheduleType) || schedTypes[0];
        s.startTimeType = timeTypes.find((t) => t.val === body.startTimeType) || timeTypes[0];
        s.endTimeType = timeTypes.find((t) => t.val === body.endTimeType) || timeTypes[0];
        if (!existing) schedules.push(s);
        return send(res, 200, s);
      }
      if (key === 'DELETE /config/schedule') {
        schedules = schedules.filter((s) => s.id !== parseInt(body.id, 10));
        return send(res, 200, {});
      }
      send(res, 404, { message: `Mock has no route for ${key}` });
    } catch (err) {
      send(res, err.status || 500, { message: err.message });
    }
  });
}).listen(PORT, () => console.log(`Mock poolController on http://localhost:${PORT}`));
