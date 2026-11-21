# Changelog

Every change to Pool Remote gets a release version, shown at the bottom of the app
(`Pool Remote vX.Y.Z (commit) · date`). Update from the app (Update bar / "Check for updates" in the footer), or on the Pi with:

```bash
cd ~/pool-remote && git pull && pm2 restart poolRemote
```

## 1.7.0 — 2026-11-21
- **Update from the app:** when a new version is on GitHub, a bar at the top shows what's new
  and an **Update** button. One tap updates Pool Remote on the Pi and restarts it (via pm2).
  Only clean fast-forward updates from this repository are allowed; "Check for updates" is
  in the footer.

## 1.6.1 — 2026-11-21
- Panel settings → Custom names: collapsed by default, explains what it's for, and shows the
  factory placeholders ("USERNAME-01"…) as unused.

## 1.6.0 — 2026-11-21
- **Water and air temperature together** in the top card (air moved out of the title bar).
- **"Now" summary** in the same card: mode, pumps (IntelliFlo RPM and watts, plus running
  equipment pumps like the water feature pump), heater status, what else is on, the running
  or next schedule, freeze protection, and the total cost per hour right now.

## 1.5.1 — 2026-11-21
- Panel settings: egg timers under an hour read "59 min" instead of "0 h 59 min".

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
