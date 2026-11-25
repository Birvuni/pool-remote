# Changelog

Every change to Pool Remote gets a release version, shown at the bottom of the app
(`Pool Remote vX.Y.Z (commit) · date`). Update from the app (Update bar / "Check for updates" in the footer), or on the Pi with:

```bash
cd ~/pool-remote && git pull && pm2 restart poolRemote
```

## 1.9.0 — 2026-11-25
- **IntelliBrite colors:** the Lights card has buttons for the 6 light shows (Party, Romance,
  Caribbean, American, California Sunset, Royal) and 5 colors (Blue, Green, Red, White, Magenta).
  One tap switches all IntelliBrite lights to it (turning them on); the active one is
  highlighted, with "Now: …" underneath. Sent through the EasyTouch's IntelliBrite light group.

## 1.8.0 — 2026-11-25
- **Cold-weather alerts** (new card + settings): cold air at your threshold (default 38°F),
  freeze protection on/off, **pump not running in freezing air** (urgent, repeats every 30 min),
  and "no data from the controller". A banner at the top shows cold / freeze protection /
  danger, with a one-tap "Start Pool". Phone notifications through the free **ntfy** app
  (private random topic, Send test button); history of recent alerts in the app.
- **Mode buttons blink slowly** while a mode change is in progress, until the controller
  confirms it (up to 2 minutes; then a message). Reduced-motion setting: dashed outline instead.
- **Raspberry Pi card redesigned:** four equal tiles (CPU, chip temp, memory, Wi-Fi) with a value
  and a status word each, power-supply notes underneath, overall status and Details.
- Fix: warning tiles/dots were mis-sized by a style that leaked from Panel settings.

## 1.7.2 — 2026-11-23
- **Frozen-data warning.** If poolController stops getting updates from the controller (its copy
  of the panel clock stops advancing for 3 minutes, or is hours behind), the status line turns
  red ("No data from the controller since …"), the top card shows "Not updating" with how to
  fix it, and "Cost now" is hidden. Previously frozen data looked current.
- **Energy isn't recorded from frozen data** (it showed equipment running that wasn't).
- `POST /local/energy/delete-days` removes bad days from the history (see README).
- `dev/patch-njspc-pump.js` adds a 4th poolController fix: on EasyTouch, "reload configuration"
  (dashPanel button or /app/config/reload) froze all status updates until a restart.
- `dev/bus-check.js` no longer triggers a configuration reload.

## 1.7.1 — 2026-11-22
- Fix: the "Update available" bar (and the Pi strip) could show even when there was nothing to
  show, because a style rule overrode "hidden". Hidden elements now always stay hidden.
- Fix: update checks no longer depend on the clone tracking GitHub's branches (uses what
  `git fetch` just downloaded).
- Energy: long equipment names wrap instead of being cut off.

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
