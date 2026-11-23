// EasyTouch configuration endpoints for the mock poolController (used by Panel Settings).
// Mirrors the shapes poolController 10.1.0 returns for an EasyTouch.

module.exports = function makeConfig({ circuits, features, circuitTypes, bodies, days }) {
  const functions = [
    { val: 0, name: 'generic', desc: 'Generic' },
    { val: 1, name: 'spa', desc: 'Spa' },
    { val: 2, name: 'pool', desc: 'Pool' },
    { val: 5, name: 'mastercleaner', desc: 'Master Cleaner' },
    { val: 7, name: 'light', desc: 'Light', isLight: true },
    { val: 16, name: 'intellibrite', desc: 'Intellibrite', isLight: true },
    { val: 19, name: 'notused', desc: 'Not Used' },
  ];
  const builtInNames = ['Not Used', 'Aux 1', 'Aux 2', 'Aux 3', 'Aux 4', 'Air Blower', 'Cleaner', 'Floor Cleaner',
    'Fountain', 'Lights', 'Pool', 'Spa', 'Water Feature', 'Waterfall', 'Spa Light', 'Pool Light'];
  const names = builtInNames.map((d, i) => ({ val: i, name: d.toLowerCase().replace(/\s/g, ''), desc: d }));
  const customNames = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `USERNAME-${String(i + 1).padStart(2, '0')}` }));
  const allNames = () => names.concat(customNames.map((c) => ({ val: 200 + c.id, name: c.name, desc: c.name })));
  const nameDesc = (nameId) => (allNames().find((n) => n.val === nameId) || {}).desc;
  const options = { manualHeat: false, clockSource: 'manual', adjustDST: true };
  // The panel clock runs 7 minutes slow until someone sets it.
  let clockOffsetMs = -7 * 60000;

  // Give every circuit/feature its config fields.
  for (const c of circuits.concat(features)) {
    c.nameId = names.find((n) => n.desc.toLowerCase() === c.name.toLowerCase())?.val ?? 1;
    c.freeze = c.name === 'Pool';
    c.eggTimer = 720;
    c.dontStop = false;
    c.showInFeatures = true;
  }

  // IntelliFlo setup in the EasyTouch: slot 1 (address 96). MOCK_PUMP_ID=2 reproduces the
  // unpatched poolController that stores it as pump #2.
  const vsType = { val: 128, name: 'vs', desc: 'Intelliflo VS', minSpeed: 450, maxSpeed: 3450, speedStepSize: 10, maxCircuits: 8, hasAddress: true };
  const dsType = { val: 65, name: 'ds', desc: 'Two-Speed', maxCircuits: 4, hasAddress: false };
  const vsPump = {
    id: parseInt(process.env.MOCK_PUMP_ID || '1', 10), type: 128, address: 96, name: 'Intelliflo VS', isActive: true,
    circuits: [{ id: 1, circuit: 6, speed: 2500, units: 0 }, { id: 2, circuit: 1, speed: 3000, units: 0 }, { id: 3, circuit: 4, speed: 2000, units: 0 }],
  };
  const dsPump = { id: 10, type: 65, name: 'Two Speed', isActive: true, circuits: [] };

  const toConfig = (c) => ({ id: c.id, name: c.name, nameId: c.nameId, type: c.type.val, freeze: c.freeze, eggTimer: c.eggTimer, dontStop: c.dontStop, showInFeatures: c.showInFeatures, isActive: true });
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

  // PUT /mock/freeze {at: ISO|null}: simulate poolController no longer receiving status
  // (its panel clock stops), like after /app/config/reload on an unpatched EasyTouch.
  let frozenAt = null;
  function panelTime() {
    const d = frozenAt ? new Date(frozenAt) : new Date(Date.now() + clockOffsetMs);
    const tzo = d.getTimezoneOffset();
    const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
    // Same format as poolController's Timestamp.toISOLocal (no colon in the offset).
    return new Date(d.getTime() - tzo * 60000).toISOString().slice(0, -1) + (tzo > 0 ? '-' : '+') + pad(tzo / 60) + pad(tzo % 60);
  }

  function setCircuitConfig(list, body) {
    const c = list.find((x) => x.id === parseInt(body.id, 10));
    if (!c) throw bad(`Invalid id ${body.id}`);
    const type = parseInt(body.type, 10);
    const fn = functions.find((f) => f.val === type);
    if (!fn) throw bad(`Invalid function ${body.type}`);
    if ((fn.name === 'pool' || fn.name === 'spa') && circuits.some((x) => x.id !== c.id && x.type.name === fn.name)) {
      throw bad(`Only one ${fn.name} circuit type is allowed.`);
    }
    if (typeof body.freeze === 'undefined') throw bad('mock: freeze must always be sent (EasyTouch packet uses it as-is)');
    c.nameId = parseInt(body.nameId, 10);
    c.name = nameDesc(c.nameId) || c.name;
    c.type = circuitTypes[fn.name] || fn;
    c.freeze = !!body.freeze;
    c.eggTimer = parseInt(body.eggTimer, 10) || 720;
    c.dontStop = !!body.dontStop;
    return toConfig(c);
  }

  function handle(key, body) {
    switch (key) {
      case 'GET /config/options/circuits':
        return { functions, equipmentNames: allNames(), circuits: circuits.map(toConfig), controllerType: 'easytouch' };
      case 'GET /config/options/features':
        return { functions, equipmentNames: allNames(), features: features.map(toConfig) };
      case 'GET /config/options/pumps':
        return {
          pumpTypes: [{ val: 1, name: 'vf', desc: 'Intelliflo VF', maxCircuits: 8, hasAddress: true }, vsType, dsType],
          circuits: circuits.filter((c) => c.type.name !== 'notused').map((c) => ({ id: c.id, name: c.name })).concat(features.map((f) => ({ id: f.id, name: f.name }))),
          pumps: [dsPump, vsPump].map((p) => JSON.parse(JSON.stringify(p))),
        };
      case 'GET /config/options/customNames':
        return { maxCustomNames: 10, customNames };
      case 'GET /config/options/general':
        return { pool: { options } };
      case 'GET /config/options/dateTime':
        return { dow: days.map((d) => ({ ...d, bitval: d.val })) };
      case 'GET /config/options/heaters':
        return { heaters: [{ id: 1, type: 1, name: 'Gas Heater', isActive: true }], heaterTypes: [{ val: 1, name: 'gas', desc: 'Gas Heater' }] };
      case 'PUT /config/circuit': return setCircuitConfig(circuits, body);
      case 'PUT /config/feature': return setCircuitConfig(features, body);
      case 'PUT /config/pump': {
        if (parseInt(body.id, 10) !== vsPump.id) throw bad(`mock: no pump #${body.id}`);
        if (vsPump.id !== vsPump.address - 95) throw bad('mock: would write to the wrong EasyTouch slot');
        const seen = new Set();
        vsPump.circuits = (body.circuits || []).map((c, i) => {
          const speed = parseInt(c.speed, 10);
          if (!(speed >= 450 && speed <= 3450)) throw bad(`Bad speed ${c.speed}`);
          if (seen.has(c.circuit)) throw bad(`circuit #${c.circuit} included more than once`);
          seen.add(c.circuit);
          return { id: i + 1, circuit: parseInt(c.circuit, 10), speed, units: 0 };
        });
        return vsPump;
      }
      case 'PUT /config/customName': {
        const n = customNames.find((x) => x.id === parseInt(body.id, 10));
        if (!n) throw bad('Custom Name Id out of range');
        n.name = String(body.name).slice(0, 11);
        for (const c of circuits.concat(features)) if (c.nameId === 200 + n.id) c.name = n.name;
        return n;
      }
      case 'PUT /config/body': {
        const b = bodies.find((x) => x.id === parseInt(body.id, 10));
        if (!b) throw bad('Invalid body');
        if (typeof body.manualHeat !== 'undefined') options.manualHeat = !!body.manualHeat;
        return b;
      }
      case 'PUT /mock/freeze':
        frozenAt = body.at ? Date.parse(body.at) : null;
        return { frozenAt: frozenAt ? new Date(frozenAt).toISOString() : null };
      case 'PUT /config/dateTime': {
        const now = new Date();
        const set = new Date(2000 + body.year, body.month - 1, body.date, body.hour, body.min, now.getSeconds());
        clockOffsetMs = set - now;
        if (typeof body.dst !== 'undefined') options.adjustDST = !!body.dst;
        if (body.clockSource === 'server' || body.clockSource === 'manual') options.clockSource = body.clockSource;
        return { time: panelTime(), adjustDST: options.adjustDST, clockSource: options.clockSource };
      }
      default:
        return undefined;
    }
  }

  // RPM the IntelliFlo runs at: the highest configured speed among circuits/features that are on.
  function vsSpeed() {
    const on = new Set(circuits.concat(features).filter((c) => c.isOn).map((c) => c.id));
    return vsPump.circuits.filter((c) => on.has(c.circuit)).reduce((m, c) => Math.max(m, c.speed), 0);
  }

  return { handle, panelTime, vsSpeed, vsPump, options };
};
