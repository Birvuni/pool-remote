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
- **Energy**: pump electricity and gas-heater cost: live readout, today / last 7 days /
  this month (with a full-month projection), pump cost by speed, and a daily log.
  - Pump power is measured: needs a pump that reports watts (e.g. IntelliFlo on the EasyTouch COM port).
  - Gas is estimated: burner hours (while the controller calls for gas heat) × heater input rating.
    Only counts heating the EasyTouch controls (heater in remote mode).
  - Tap **Rates** to set ¢/kWh, $ per CCF of gas, and heater BTU/hr.
- Schedules: view, add, edit, delete

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
| `GAS_INPUT_BTU` | `264000` | Heater input rating, BTU/hr (Raypak Avia 264A) |
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
`PUT /local/energy/settings` `{rate, gasRate, gasInputBtu}` ($/kWh, $/CCF, BTU/hr).
