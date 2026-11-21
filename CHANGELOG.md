# Changelog

Every change to Pool Remote gets a release version, shown at the bottom of the app
(`Pool Remote vX.Y.Z (commit) · date`). Update the Pi with:

```bash
cd ~/pool-remote && git pull && pm2 restart poolRemote
```

## 1.5.0 — 2026-11-21
- **Pi health strip** at the top: CPU, temperature, memory, Wi-Fi signal, with warnings for
  heat, weak Wi-Fi, a full disk, and power-supply under-voltage. Tap it for details.
- **Faster updates:** the app takes a fresh energy reading right after you switch equipment,
  then again after 4 s and 10 s while pumps ramp up. Energy refreshes every 10 s (was 30 s).
- **Equipment categories** (Pump / Heating / Other) in Energy → Settings. Items marked Pump
  (e.g. the water feature pump) appear in the Pump card with their own status and cost.
- **Analytics page:** cost, energy, and run time by equipment, per day or per month, with charts.
- **Version and changelog:** this file, and the release version at the bottom of every page.
- Safety: if the energy data file can't be read, it's kept as `energy.json.unreadable-<time>`
  instead of being overwritten with an empty history.
- Layout: wide tables scroll inside their card instead of widening the page on phones.

## 1.4.1
- Hide the EasyTouch's "Two Speed" entry whenever an IntelliFlo is present, even while it's off.

## 1.4.0
- **Panel settings** (gear icon): IntelliFlo speeds, circuits and features, custom names,
  spa manual heat, clock. Every write asks for confirmation.
- poolController patch also stores pumps with id = EasyTouch slot.

## 1.3.x
- Equipment settings for energy tracking (any circuit, feature, Pool/Spa mode, or heater).
- Bus check and poolController patch for the missing IntelliFlo.

## 1.2.0
- Gas heater tracking (burner time × BTU rating).

## 1.1.0
- Pump energy tracking (measured watts from the IntelliFlo).

## 1.0.0
- First release: mode, heat, lights and aux, pump status, schedules.
