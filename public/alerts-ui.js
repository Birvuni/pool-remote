'use strict';
// Cold-weather alerts: the banner at the top, the Alerts card, and its settings sheet.
// Uses globals from app.js: $, esc, toast, S, bodies, setMode, staleInfo, fmtTemp, unit.

let AL = null; // /local/alerts response
const SPEED_PUMP_TYPES = ['vs', 'vssvrs', 'vsf', 'vf'];

async function loadAlerts() {
  try {
    const res = await fetch('/local/alerts');
    if (!res.ok) throw new Error(`Alerts unavailable (${res.status})`);
    AL = await res.json();
    renderAlertsCard();
    renderColdBanner();
  } catch (err) {
    $('alertsBody').innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

const isC = () => S?.temps?.units?.name === 'C';
const threshold = () => (typeof AL?.settings?.airThreshold === 'number' ? AL.settings.airThreshold : isC() ? 3 : 38);
const dangerTemp = () => (isC() ? 1 : 34);

function waterMovingNow() {
  if (!S) return false;
  if (bodies().some((b) => b.isOn) || S.freeze) return true;
  return (S.pumps || []).some((p) => SPEED_PUMP_TYPES.includes((p.type?.name || '').toLowerCase()) && p.rpm > 0);
}

// Banner from the live state, so it changes as soon as the screen does.
function renderColdBanner() {
  const box = $('coldBanner');
  const air = S?.temps?.air;
  if (!S || typeof air !== 'number' || staleInfo()) { box.hidden = true; return; }
  const u = unit();
  const t = `${fmtTemp(air)}${u}`;
  let html = '', danger = false;
  if (air <= dangerTemp() && !waterMovingNow()) {
    danger = true;
    const pool = bodies().find((b) => (b.type?.name || '').toLowerCase() === 'pool') || bodies()[0];
    html = `<div><b>🚨 Freezing air (${t}) and the pump isn't running</b>
      Pipes and equipment can freeze. Start the pump now.</div>
      ${pool ? `<button type="button" class="btn primary" id="coldStart" data-mode-start="${pool.id}">Start ${esc(pool.name)}</button>` : ''}`;
  } else if (S.freeze) {
    html = `<div><b>🛡️ Freeze protection is running</b>Air ${t}. The pump keeps water moving through the pipes.</div>`;
  } else if (air <= threshold()) {
    html = `<div><b>❄️ Cold weather · air ${t}</b>Freeze protection starts on its own near ${isC() ? '2°C' : '36°F'}.</div>`;
  }
  box.hidden = !html;
  box.className = 'cold-banner' + (danger ? ' danger' : '');
  box.innerHTML = html;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderAlertsCard() {
  if (!AL) return;
  const s = AL.settings, st = AL.status || {};
  const n = s.notify;
  const u = st.unit || unit();
  const rows = [
    ['Phone', n.enabled && n.topic ? `On · ntfy topic ${n.topic}` : 'Off · tap Settings to get alerts on your phone'],
    ['Air now', typeof st.air === 'number' ? `${Math.round(st.air)}${u}` : '—'],
    ['Cold alert at', `${s.airThreshold}${u}`],
    ['Freeze protection', st.freeze ? 'Running' : 'Not running'],
  ];
  if (st.ok === false && st.error) rows.push(['Problem', st.error]);
  const hist = AL.history || [];
  const list = hist.slice(0, 20).map((a) => `
    <li class="${a.priority >= 5 ? 'urgent' : ''}">
      <b>${esc(a.title)}</b><br>${esc(a.message)}
      <div class="when">${esc(fmtWhen(a.at))}${a.sent ? ' · sent to phone' : a.error ? ` · not sent: ${esc(a.error)}` : ''}</div>
    </li>`).join('');
  // Recent alerts fold into a drop-down; keep it open across the periodic redraws.
  const wasOpen = !!document.querySelector('#alHistory')?.open;
  const latest = hist[0];
  $('alertsBody').innerHTML = `
    <dl class="al-status">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${hist.length ? `<details class="al-history" id="alHistory" ${wasOpen ? 'open' : ''}>
      <summary><span class="al-sum-title">Recent alerts <span class="al-count">${hist.length}</span></span>
        <span class="al-sum-latest">Latest: ${esc(latest.title)} · ${esc(fmtWhen(latest.at))}</span></summary>
      <ul class="al-list">${list}</ul>
    </details>` : '<p class="hint">No alerts yet.</p>'}`;
}

function randomTopic() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return 'pool-' + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
}

function openAlerts() {
  if (!AL) { toast('Alerts not loaded yet', true); return; }
  const s = AL.settings;
  $('alNotify').checked = !!s.notify.enabled;
  $('alTopic').value = s.notify.topic || randomTopic();
  $('alServer').value = s.notify.server || 'https://ntfy.sh';
  $('alThreshold').value = s.airThreshold;
  $('alThresholdLabel').textContent = `Cold alert when air drops to (${unit()})`;
  $('alRuleCold').checked = !!s.rules.cold;
  $('alRuleFreeze').checked = !!s.rules.freeze;
  $('alRulePumpOff').checked = !!s.rules.pumpOff;
  $('alRuleStale').checked = !!s.rules.stale;
  $('alertsDialog').showModal();
}

function alertsForm() {
  return {
    notify: { enabled: $('alNotify').checked, topic: $('alTopic').value.trim(), server: $('alServer').value.trim() },
    airThreshold: parseFloat($('alThreshold').value),
    rules: { cold: $('alRuleCold').checked, freeze: $('alRuleFreeze').checked, pumpOff: $('alRulePumpOff').checked, stale: $('alRuleStale').checked },
  };
}

async function saveAlerts(close = true) {
  const res = await fetch('/local/alerts/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(alertsForm()) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Could not save');
  AL = data;
  renderAlertsCard();
  renderColdBanner();
  if (close) $('alertsDialog').close();
}

async function testAlerts() {
  const btn = $('alTest');
  btn.disabled = true;
  try {
    await saveAlerts(false); // test what's on screen
    const res = await fetch('/local/alerts/test', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Test failed');
    toast('Test sent. Check your phone.');
    await loadAlerts();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

$('openAlerts').addEventListener('click', openAlerts);
$('alCancel').addEventListener('click', () => $('alertsDialog').close());
$('alNewTopic').addEventListener('click', () => { $('alTopic').value = randomTopic(); });
$('alTest').addEventListener('click', testAlerts);
$('alertsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveAlerts().then(() => toast('Alert settings saved')).catch((err) => toast(err.message, true));
});
$('coldBanner').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode-start]');
  if (b) setMode(b.dataset.modeStart);
});

setInterval(() => { if (document.visibilityState === 'visible') renderColdBanner(); }, 4000);
setInterval(() => { if (document.visibilityState === 'visible') loadAlerts(); }, 30000);
loadAlerts();
