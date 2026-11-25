// GitHub Pages hosts this static dashboard; the live API and MQTT bridge run on Render.
const API_BASE = 'https://smart-traffic-light-control-system.onrender.com';
const apiUrl = path => `${API_BASE}${path}`;

const $ = id => document.getElementById(id);

function paint(t) {
  $('north').textContent = `${Number(t.north_cm || 0).toFixed(1)} cm`;
  $('east').textContent = `${Number(t.east_cm || 0).toFixed(1)} cm`;
  $('timer').textContent = `${t.remaining_sec || 0} s`;
  $('mode').textContent = t.mode || 'AUTO';
  $('device').textContent = t.device_id || '--';
  $('ns').textContent = t.ns_signal || 'RED';
  $('ew').textContent = t.ew_signal || 'GREEN';
  $('ns').className = 'signal ' + String(t.ns_signal || 'RED').toLowerCase();
  $('ew').className = 'signal ' + String(t.ew_signal || 'GREEN').toLowerCase();
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

async function loadTelemetry() {
  try {
    const response = await fetch(apiUrl('/api/telemetry?limit=30'));
    if (!response.ok) throw new Error(`Telemetry API returned HTTP ${response.status}`);
    renderRows(await response.json());
  } catch (error) {
    console.error('Could not load telemetry from Render:', error);
  }
}

async function loadLatest() {
  try {
    const response = await fetch(apiUrl('/api/latest'));
    if (!response.ok) throw new Error(`Latest API returned HTTP ${response.status}`);
    const data = await response.json();
    if (data && data.north_cm !== undefined) paint(data);
  } catch (error) {
    console.error('Could not load latest telemetry from Render:', error);
  }
}

async function updateHealth() {
  try {
    const response = await fetch(apiUrl('/health'));
    if (!response.ok) throw new Error(`Health API returned HTTP ${response.status}`);
    const health = await response.json();
    $('status').textContent = `Adafruit IO MQTT: ${health.mqtt || 'unknown'}`;
    $('database-status').textContent = 'DB: NOT CONFIGURED';
    $('status').classList.toggle('connected', health.mqtt === 'connected');
  } catch (error) {
    $('status').textContent = 'BACKEND: UNAVAILABLE';
    $('database-status').textContent = 'DB: NOT CONFIGURED';
    console.error('Render backend health check failed:', error);
  }
}

window.control = async mode => {
  try {
    const response = await fetch(apiUrl('/api/control'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Control command failed');
    alert(`Sent ${mode} to Adafruit IO.`);
  } catch (error) {
    alert(error.message);
  }
};

$('refresh').addEventListener('click', loadTelemetry);
loadTelemetry();
loadLatest();
updateHealth();
setInterval(updateHealth, 5000);

const events = new EventSource(apiUrl('/events'));
events.onmessage = event => {
  try {
    paint(JSON.parse(event.data));
    loadTelemetry();
  } catch (error) {
    console.error('Invalid live event from Render:', error);
  }
};
events.onerror = () => {
  $('status').textContent = 'Adafruit IO MQTT: WAITING FOR CONNECTION';
  $('status').classList.remove('connected');
};
