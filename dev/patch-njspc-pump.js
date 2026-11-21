// Fix for a nodejs-poolController (10.1.0) bug on *Touch controllers that hides IntelliFlo pumps.
//
// When the controller reports its pump slots (packets 24/27), poolController creates the pump for
// slot 1 with an id based on how many pumps already exist. With a Two-Speed pump already defined,
// the IntelliFlo gets id 2. The next reply, "slot 2 = none", then deletes *pump id 2* — the
// IntelliFlo that was just created. The fix removes the pump at slot 2's *address* instead.
//
// Usage on the Pi:
//   node dev/patch-njspc-pump.js            apply the fix (keeps a backup), then: pm2 restart poolController
//   node dev/patch-njspc-pump.js --revert   restore the original file,   then: pm2 restart poolController
//   node dev/patch-njspc-pump.js --check    only report whether the fix is applied
// Optional 2nd argument: path to the nodejs-poolController folder (default ~/nodejs-poolController).

const fs = require('fs');
const os = require('os');
const path = require('path');

const mode = process.argv[2] || '--apply';
const root = process.argv[3] || path.join(os.homedir(), 'nodejs-poolController');
const file = path.join(root, 'controller', 'comms', 'messages', 'config', 'PumpMessage.ts');
const backup = file + '.orig';

const ORIGINAL = `            // RKS: Remove any pump that is not defined in the system.
            sys.pumps.removeItemById(pumpId);
            state.pumps.removeItemById(pumpId);`;

const FIXED = `            // RKS: Remove any pump that is not defined in the system.
            // pool-remote fix: remove the pump at this slot's address, not the pump whose id equals the
            // slot number (that can be a different pump, e.g. an IntelliFlo created as id 2).
            const stalePump = sys.pumps.find(p => p.address === 95 + pumpId);
            if (typeof stalePump !== 'undefined') {
                sys.pumps.removeItemById(stalePump.id);
                state.pumps.removeItemById(stalePump.id);
            }`;

if (!fs.existsSync(file)) {
  console.error(`Not found: ${file}\nPass the nodejs-poolController folder as the 2nd argument.`);
  process.exit(1);
}
const src = fs.readFileSync(file, 'utf8');
const applied = src.includes('pool-remote fix:');

if (mode === '--check') {
  console.log(applied ? 'Fix is applied.' : 'Fix is NOT applied.');
  process.exit(0);
}

if (mode === '--revert') {
  if (!fs.existsSync(backup)) { console.error('No backup found; nothing to revert.'); process.exit(1); }
  fs.copyFileSync(backup, file);
  console.log('Original restored. Now run: pm2 restart poolController');
  process.exit(0);
}

if (applied) { console.log('Fix is already applied. Nothing to do.'); process.exit(0); }
const count = src.split(ORIGINAL).length - 1;
if (count !== 1) {
  console.error('The code does not match what this fix expects (different poolController version?).');
  console.error('No changes made.');
  process.exit(1);
}
fs.copyFileSync(file, backup);
fs.writeFileSync(file, src.replace(ORIGINAL, FIXED));
console.log(`Fix applied to ${file}`);
console.log(`Backup saved as ${backup}`);
console.log('Now run: pm2 restart poolController   (it rebuilds on start; takes ~1-2 minutes on a Pi 3)');
