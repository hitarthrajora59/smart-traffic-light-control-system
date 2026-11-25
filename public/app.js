const $ = id => document.getElementById(id);

function paint(t) {
  $('north').textContent = `${Number(t.north_cm || 0).toFixed(1)} cm`;
  $('east').textContent = `${Number(t.east_cm || 0).toFixed(1)} cm`;
  $('timer').textContent = `${t.remaining_sec || 0} s`;
  $('mode').textContent = t.mode || '--';
  $('device').textContent = t.device_id || '--';
  $('ns').textContent = t.ns_signal || '--';
  $('ew').textContent = t.ew_signal || '--';
  $('ns').className = 'signal ' + String(t.ns_signal || '').toLowerCase();
  $('ew').className = 'signal ' + String(t.ew_signal || '').toLowerCase();
  $('countN').textContent = `${t.north_count || 0} vehicles`;
  $('countE').textContent = `${t.east_count || 0} vehicles`;
  $('barN').style.width = Math.min(100, Number(t.north_count || 0) * 10) + '%';
  $('barE').style.width = Math.min(100, Number(t.east_count || 0) * 10) + '%';
  const total = Number(t.north_count || 0) + Number(t.east_count || 0);
  $('density').textContent = `${total} · ${total >= 10 ? 'High' : total >= 4 ? 'Moderate' : 'Low'}`;
  $('access').textContent = 'Security: ' + (t.access_granted ? 'ACCESS GRANTED' : 'locked');
}

function renderRows(records) {
  const body = $('log');
  body.replaceChildren();
  for (const t of records) {
    const row = document.createElement('tr');
    const date = new Date(t.ts);
    const values = [
      Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString(),
      t.device_id, Number(t.north_cm || 0).toFixed(1),
      Number(t.east_cm || 0).toFixed(1), t.ns_signal, t.ew_signal,
      `${t.remaining_sec || 0}s`, t.mode
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value ?? '';
      row.append(cell);
    }
    body.append(row);
  }
}

async function load() {
  try {
    const response = await fetch('/api/telemetry?limit=30');
    if (!response.ok) throw new Error('Telemetry request failed');
    renderRows(await response.json());
  } catch (error) {
    console.error(error);
  }
}

async function loadLatest() {
  try {
    const response = await fetch('/api/latest');
    const data = await response.json();
    if (response.ok && data && data.north_cm !== undefined) paint(data);
  } catch (error) {
    console.error(error);
  }
}

async function updateHealth() {
  try {
    const response = await fetch('/health');
    const health = await response.json();
    $('status').textContent = `Adafruit IO MQTT: ${health.mqtt || 'unknown'}`;
    $('database-status').textContent = 'DB: NOT CONFIGURED';
    $('status').classList.toggle('connected', health.mqtt === 'connected');
  } catch {
    $('status').textContent = 'BACKEND: UNAVAILABLE';
  }
}

window.control = async mode => {
  const status = $('control-status');
  status.textContent = 'Sending command...';
  try {
    const response = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Control command failed');
    status.textContent = `Sent ${mode} to Adafruit IO.`;
  } catch (error) {
    status.textContent = error.message;
  }
};

$('refresh').addEventListener('click', load);
load();
loadLatest();
updateHealth();
setInterval(updateHealth, 5000);

const events = new EventSource('/events');
events.onmessage = event => {
  try {
    paint(JSON.parse(event.data));
    load();
  } catch (error) {
    console.error('Invalid live event', error);
  }
};
events.onerror = () => {
  $('status').textContent = 'Adafruit IO MQTT: WAITING FOR CONNECTION';
  $('status').classList.remove('connected');
};
