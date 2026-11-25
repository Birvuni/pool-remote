# Pool Remote

A phone-friendly remote for a Pentair EasyTouch pool system. It runs on the Raspberry Pi
next to [nodejs-poolController](https://github.com/tagyoureit/nodejs-poolController) (njsPC)
and talks to it through njsPC's REST API.

**Main screen**
- Water temperature (pool or spa), air temperature, heating status
- One-tap **Off / Pool / Spa** mode
- Heat setpoint (− / +) and heat mode per body
- Lights and aux/feature toggles (hide unused ones with **Edit**; saved per phone)
- Filter pump status
- **Energy**: electricity and gas cost: live readout, today / last 7 days / this month
  (with a full-month projection), cost by equipment and by pump speed, and a daily log.
  - Pump power is **measured** when the pump reports watts (e.g. IntelliFlo on the EasyTouch COM port).
  - Other equipment is **estimated**: run time × rating. In **Energy → Settings**, add each item
    (name, what it's counted with, electric watts or gas BTU/hr) and set your ¢/kWh and $/CCF.
    - "Counted while" can be any circuit or feature (e.g. Air Blower), Pool/Spa mode, or
      "Heater is firing" (while the controller calls for gas heat; heater must be in remote mode).
    - Costs are computed from logged run time and the *current* rating, so correcting a
      rating also corrects past days.
- Schedules: view, add, edit, delete
- **Cold-weather alerts**: in-app banner and history, phone notifications via the free ntfy app
  (Cold-weather alerts → Settings: turn on, subscribe to the shown topic in ntfy, Send test)
- **Pi health** strip at the top (CPU, temperature, memory, Wi-Fi, power-supply warnings; tap for details)
- **Analytics** page (Energy → Analytics): cost, energy and run time by equipment, per day or month
- Release version at the bottom of every page; see [CHANGELOG.md](CHANGELOG.md)
- **Panel settings** (gear icon): view and change the EasyTouch's own settings, with a confirmation
  before anything is written to the panel:
  - IntelliFlo speeds (RPM per circuit/feature)
  - circuits and features: name, function, freeze protection, egg timer (Pool/Spa function is locked)
  - custom names, spa manual heat, panel clock (set now, daylight saving, auto-sync from the Pi)
  - read-only: controller model, heaters, poolController version

  Pump speeds need `dev/patch-njspc-pump.js` applied (see Troubleshooting). Without it the app
  blocks saving, because poolController would write the speeds to the wrong pump slot.

No dependencies and no build step: just Node.js.

## How it fits together

```
Phone ──http──▶ Pool Remote (Pi :8080) ──/api/*──▶ nodejs-poolController (Pi :4200) ──RS-485──▶ EasyTouch
```

The server serves the app from `public/` and forwards every `/api/...` request to njsPC.
Your phone only ever talks to port 8080.

## Install on the Pi

Prerequisites (already done if you followed the setup): Node.js 22, pm2, and
nodejs-poolController running on port 4200.

```bash
cd ~
git clone https://github.com/<you>/pool-remote.git
cd pool-remote
pm2 start server.js --name poolRemote
pm2 save
```

Open **http://poolpi.local:8080** (or `http://<pi-ip>:8080`) on your phone.

### Add it to your home screen

- **iPhone:** open it in Safari → Share → **Add to Home Screen**.
- **Android:** Chrome menu → **Add to Home screen** / **Install app**.

### Update

```bash
cd ~/pool-remote && git pull && pm2 restart poolRemote
```

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port the app listens on |
| `NJSPC_URL` | `http://127.0.0.1:4200` | Where nodejs-poolController is |
| `ENERGY_RATE` | `0.14` | Starting electricity rate in $/kWh (change it later in the app) |
| `ENERGY_SAMPLE_MS` | `30000` | How often pump power and heater state are sampled |
| `GAS_INPUT_BTU` | `264000` | Starting rating of the default "Gas heater" item, BTU/hr (Raypak Avia 264A) |
| `GAS_RATE` | `2.97` | Starting gas price per unit (change it later in the app) |
| `GAS_UNIT` / `GAS_BTU_PER_UNIT` | `CCF` / `103700` | Gas billing unit and its energy content |

Gas math: `units = BTU/hr × hours ÷ BTU per unit`. A 264,000 BTU/hr heater burns
≈ 2.55 CCF per hour of firing.

### Energy data

The server samples pump power every 30 s and keeps daily totals (up to 400 days) in
`data/energy.json`, saved every 5 minutes and on shutdown. Time when the Pi or
poolController was down for more than 3 minutes isn't counted. Delete the file to start over.

Example: `PORT=80 pm2 start server.js --name poolRemote --update-env`

## Remote access

Don't open ports on your router. Install [Tailscale](https://tailscale.com) on the Pi
(`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`) and on your
phone, then use `http://poolpi:8080` from anywhere.

There is no login screen: anyone who can reach the Pi on your network can use the app.
Tailscale keeps it off the public internet.

## Developing without the pool

`dev/mock-njspc.js` is a fake njsPC that behaves like an EasyTouch with a shared pool/spa:

```bash
npm run mock                                    # fake controller on :4200
npm start                                       # app on :8080
```

## API calls used

| Action | njsPC endpoint |
|---|---|
| Read everything (polled every 4 s) | `GET /state/all` |
| Pool/Spa/Off, lights, aux | `PUT /state/circuit/setState` `{id, isOn}` |
| Features | `PUT /state/feature/setState` `{id, isOn}` |
| Setpoint | `PUT /state/body/setPoint` `{id, setPoint}` |
| Heat mode | `PUT /state/body/heatMode` `{id, mode}` |
| Heat modes for a body | `GET /config/body/:id/heatModes` |
| Schedule options | `GET /config/options/schedules` |
| Save / delete schedule | `PUT` / `DELETE /config/schedule` |
| Pump power (energy logger) | `GET /state/pumps` |
| Heater firing (energy logger) | `GET /state/temps` (body `heatStatus`) |

Pool Remote's own endpoints: `GET /local/energy` (report) and
`PUT /local/energy/settings` `{rate, gasRate, equipment}` where `rate` is $/kWh, `gasRate` is $/CCF and
`equipment` is the full list: `[{id, name, source: {kind: "circuit"|"feature"|"heater", id}, energy: "electric"|"gas", watts|btu}]`.

Mock with a power-reporting pump: `MOCK_INTELLIFLO=1 npm run mock`.

## Troubleshooting: the app says "No data from the controller since …"

poolController stopped receiving status from the EasyTouch, so everything it reports is frozen
(commands may still work). Fix: `pm2 restart poolController` on the Pi.

Known cause: **"reload configuration"** (dashPanel's button or `/app/config/reload`) on an
unpatched poolController 10.1.0 + EasyTouch discards all status updates until the next restart.
`node dev/patch-njspc-pump.js` fixes it. Don't use the reload; restart poolController instead.

Energy recorded while frozen is skipped automatically from 1.7.2 on. To remove days recorded
earlier, e.g. Nov 21–22:

```bash
curl -s -X POST -H 'x-pool-remote: delete-days' -H 'content-type: application/json' \
  -d '{"days":["2026-11-21","2026-11-22"]}' localhost:8080/local/energy/delete-days
```

## Troubleshooting: IntelliFlo not showing up (EasyTouch/IntelliTouch)

`node dev/bus-check.js` records the RS-485 bus for 2 minutes and reports whether a pump is
talking and what pump setup the controller reports (pump setup is sent at poolController startup).

If the pump is on the bus and the controller reports it, but poolController (10.1.0) still lists
only a "Two Speed" pump, it's a poolController bug: with a Two-Speed pump defined, the IntelliFlo
is created as pump id 2 and then deleted when the controller reports "pump slot 2: none".
`node dev/patch-njspc-pump.js` patches it (with a backup; `--revert` undoes it), then
`pm2 restart poolController`. The same script also makes poolController store *Touch pumps with
id = pump slot: saving pump settings sends the id as the slot, so an IntelliFlo stored as #2
would otherwise be written to slot 2. Re-run the patch after updating nodejs-poolController.
