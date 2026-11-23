// Fixes for nodejs-poolController (10.1.0) pump handling on *Touch controllers (EasyTouch/IntelliTouch).
//
// Bug 1 — IntelliFlo disappears: when the controller reports its pump slots (packets 24/27),
// poolController creates the pump for slot 1 with an id based on how many pumps already exist.
// With a Two-Speed pump already defined, the IntelliFlo gets id 2. The next reply, "slot 2 = none",
// then deletes *pump id 2* — the IntelliFlo that was just created.
// Fix: remove the pump at that slot's *address* instead of the pump whose id equals the slot.
//
// Bug 2 — wrong slot on save: when saving a *Touch pump (speeds etc.), poolController sends the
// pump's *id* as the controller's pump slot. An IntelliFlo saved as id 2 would be written to slot 2.
// Fix: create *Touch pumps with id = slot, and re-create a pump that was stored under another id.
//
// Bug 3 — status freezes after "reload configuration" (dashPanel button or /app/config/reload):
// on *Touch, reloadConfig() sets modulesAcquired = false, a flag only IntelliCenter ever clears.
// From then on every status message is discarded (commands still work), so the displayed state
// freezes until poolController restarts. Fix: don't clear the flag on *Touch.
//
// Usage on the Pi:
//   node dev/patch-njspc-pump.js            apply the fixes (keeps a backup), then: pm2 restart poolController
//   node dev/patch-njspc-pump.js --revert   restore the original file,     then: pm2 restart poolController
//   node dev/patch-njspc-pump.js --check    report which fixes are applied
// Optional 2nd argument: path to the nodejs-poolController folder (default ~/nodejs-poolController).

const fs = require('fs');
const os = require('os');
const path = require('path');

const mode = process.argv[2] || '--apply';
const root = process.argv[3] || path.join(os.homedir(), 'nodejs-poolController');
const PUMP_FILE = path.join('controller', 'comms', 'messages', 'config', 'PumpMessage.ts');
const TOUCH_FILE = path.join('controller', 'boards', 'EasyTouchBoard.ts');

const FIXES = [
  {
    name: 'remove-by-address',
    file: PUMP_FILE,
    marker: 'pool-remote fix: remove the pump at this slot',
    from: `            // RKS: Remove any pump that is not defined in the system.
            sys.pumps.removeItemById(pumpId);
            state.pumps.removeItemById(pumpId);`,
    to: `            // RKS: Remove any pump that is not defined in the system.
            // pool-remote fix: remove the pump at this slot's address, not the pump whose id equals the
            // slot number (that can be a different pump, e.g. an IntelliFlo created as id 2).
            const stalePump = sys.pumps.find(p => p.address === 95 + pumpId);
            if (typeof stalePump !== 'undefined') {
                sys.pumps.removeItemById(stalePump.id);
                state.pumps.removeItemById(stalePump.id);
            }`,
  },
  {
    name: 'id-equals-slot',
    file: PUMP_FILE,
    marker: 'pool-remote fix: create *Touch pumps with id = slot',
    from: `        let pump: Pump = sys.pumps.getPumpByAddress(95 + pumpId, isActive);
        if(isActive) {`,
    to: `        // pool-remote fix: create *Touch pumps with id = slot, because saving a pump sends its id as the slot.
        const slotData = { id: pumpId, address: 95 + pumpId };
        const slotIdFree = () => typeof sys.pumps.find(p => p.id === pumpId) === 'undefined';
        let pump: Pump = sys.pumps.getPumpByAddress(95 + pumpId, isActive, slotIdFree() ? slotData : undefined);
        if (isActive && pump.id !== pumpId && slotIdFree()) {
            // Re-create a pump that was stored under another id (e.g. id 2 for slot 1).
            const oldId = pump.id;
            sys.pumps.removeItemById(oldId);
            state.pumps.removeItemById(oldId);
            pump = sys.pumps.getPumpByAddress(95 + pumpId, true, slotData);
        }
        if(isActive) {`,
  },
  {
    name: 'id-equals-slot-on-type-change',
    file: PUMP_FILE,
    marker: 'pool-remote fix: keep id = slot when the type changes',
    from: `                sys.pumps.removePumpByAddress(95 + pumpId);
                if (isActive) pump = sys.pumps.getPumpByAddress(95 + pumpId, isActive);`,
    to: `                sys.pumps.removePumpByAddress(95 + pumpId);
                // pool-remote fix: keep id = slot when the type changes.
                if (isActive) pump = sys.pumps.getPumpByAddress(95 + pumpId, isActive, slotIdFree() ? slotData : undefined);`,
  },
  {
    name: 'touch-reload-no-freeze',
    file: TOUCH_FILE,
    marker: 'pool-remote fix: *Touch never sends the IntelliCenter module message',
    from: `        console.log('RESETTING THE CONFIGURATION');
        this.modulesAcquired = false;`,
    to: `        console.log('RESETTING THE CONFIGURATION');
        // pool-remote fix: *Touch never sends the IntelliCenter module message (action 204) that sets
        // modulesAcquired back to true, so clearing it here made every later status message be discarded.`,
  },
];

const files = [...new Set(FIXES.map((f) => f.file))];
const abs = (f) => path.join(root, f);
const missing = files.filter((f) => !fs.existsSync(abs(f)));
if (missing.length) {
  console.error(`Not found: ${missing.map(abs).join(', ')}\nPass the nodejs-poolController folder as the 2nd argument.`);
  process.exit(1);
}
const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(abs(f), 'utf8')]));
const status = FIXES.map((f) => ({ f, applied: src[f.file].includes(f.marker) }));

if (mode === '--check') {
  for (const s of status) console.log(`${s.applied ? 'applied    ' : 'NOT applied'}  ${s.f.name}`);
  process.exit(0);
}

if (mode === '--revert') {
  let restored = 0;
  for (const f of files) {
    const backup = abs(f) + '.orig';
    if (fs.existsSync(backup)) { fs.copyFileSync(backup, abs(f)); restored++; }
  }
  if (!restored) { console.error('No backups found; nothing to revert.'); process.exit(1); }
  console.log(`Restored ${restored} original file(s). Now run: pm2 restart poolController`);
  process.exit(0);
}

const todo = status.filter((s) => !s.applied);
if (!todo.length) { console.log('All fixes are already applied. Nothing to do.'); process.exit(0); }
for (const { f } of todo) {
  if (src[f.file].split(f.from).length - 1 !== 1) {
    console.error(`The code does not match what fix "${f.name}" expects (different poolController version?).`);
    console.error('No changes made.');
    process.exit(1);
  }
}
for (const { f } of todo) src[f.file] = src[f.file].replace(f.from, f.to);
for (const f of new Set(todo.map((t) => t.f.file))) {
  const backup = abs(f) + '.orig';
  if (!fs.existsSync(backup)) fs.copyFileSync(abs(f), backup); // keep the true original from the first run
  fs.writeFileSync(abs(f), src[f]);
  console.log(`Patched ${abs(f)} (original kept as ${backup})`);
}
console.log(`Applied: ${todo.map((s) => s.f.name).join(', ')}`);
console.log('Now run: cd ~/nodejs-poolController && npx tsc --noEmit && pm2 restart poolController');
