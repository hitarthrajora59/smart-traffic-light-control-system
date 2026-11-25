import express from 'express';
import cors from 'cors';
import mqtt from 'mqtt';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 10000);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Adafruit IO MQTT configuration. Credentials are supplied through Render
// environment variables; never commit an Adafruit IO Active Key.
const AIO_USERNAME = process.env.MQTT_USERNAME || process.env.AIO_USERNAME || '';
const AIO_KEY = process.env.MQTT_PASSWORD || process.env.AIO_KEY || '';
const MQTT_URL = process.env.MQTT_URL || 'mqtts://io.adafruit.com:8883';
const GROUP_KEY = process.env.AIO_GROUP_KEY || 'smart-traffic';
const MQTT_TOPIC = process.env.MQTT_TOPIC ||
  (AIO_USERNAME ? `${AIO_USERNAME}/groups/${GROUP_KEY}` : '');
const MQTT_CONTROL_TOPIC = process.env.MQTT_CONTROL_TOPIC ||
  (AIO_USERNAME ? `${AIO_USERNAME}/feeds/control` : '');
const DEVICE_ID = process.env.DEVICE_ID || 'ESP32-Traffic';

const clients = new Set();
const recentTelemetry = [];
let latest = null;
let mqttClient = null;

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
      return source[key];
    }
  }
  return undefined;
}

function numberField(source, keys, field, min, max, integer = false) {
  const value = firstDefined(source, keys);
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed) ||
      parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new Error(`Invalid ${field}`);
  }
  return parsed;
}

// Adafruit IO group messages use feed keys with hyphens inside a "feeds" object.
// This adapter converts that payload into the dashboard's normalized schema.
function normalize(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Payload must be a JSON object');
  }

  const source = message.feeds && typeof message.feeds === 'object'
    ? message.feeds
    : message;

  const nsSignal = String(firstDefined(source, ['ns-signal', 'ns_signal']) || '').toUpperCase();
  const ewSignal = String(firstDefined(source, ['ew-signal', 'ew_signal']) || '').toUpperCase();
  const mode = String(firstDefined(source, ['mode']) || '').toUpperCase();

  if (!['RED', 'YELLOW', 'GREEN'].includes(nsSignal) ||
      !['RED', 'YELLOW', 'GREEN'].includes(ewSignal)) {
    throw new Error('Invalid signal state');
  }
  if (nsSignal === 'GREEN' && ewSignal === 'GREEN') {
    throw new Error('Conflicting GREEN signals');
  }
  if (!['AUTO', 'MANUAL_NS', 'MANUAL_EW'].includes(mode)) {
    throw new Error('Invalid operating mode');
  }

  const accessValue = firstDefined(source, ['access-granted', 'access_granted']);
  const accessGranted = accessValue === true || accessValue === 1 ||
    String(accessValue).toLowerCase() === 'true' || String(accessValue) === '1';

  const rawTimestamp = firstDefined(message, ['ts', 'timestamp']);
  const timestamp = rawTimestamp ? new Date(rawTimestamp) : new Date();
  if (Number.isNaN(timestamp.getTime())) throw new Error('Invalid timestamp');

  return {
    device_id: String(firstDefined(source, ['device_id', 'device']) || DEVICE_ID),
    ts: timestamp,
    north_cm: numberField(source, ['north-cm', 'north_cm', 'north'], 'north_cm', 0, 450),
    east_cm: numberField(source, ['east-cm', 'east_cm', 'east'], 'east_cm', 0, 450),
    north_count: numberField(source, ['north-count', 'north_count'], 'north_count', 0, 10000, true),
    east_count: numberField(source, ['east-count', 'east_count'], 'east_count', 0, 10000, true),
    ns_signal: nsSignal,
    ew_signal: ewSignal,
    remaining_sec: numberField(source, ['remaining-sec', 'remaining_sec'], 'remaining_sec', 0, 3600, true),
    mode,
    access_granted: accessGranted,
    raw: message
  };
}

function broadcast(telemetry) {
  const packet = `data: ${JSON.stringify(telemetry)}\n\n`;
  for (const response of clients) response.write(packet);
}

function startMqtt() {
  if (!AIO_USERNAME || !AIO_KEY) {
    console.warn('Adafruit IO is not configured. Set MQTT_USERNAME and MQTT_PASSWORD in Render.');
    return;
  }

  console.log('Connecting to Adafruit IO MQTT...');
  console.log('MQTT URL:', MQTT_URL);
  console.log('Telemetry topic:', MQTT_TOPIC);
  console.log('Control topic:', MQTT_CONTROL_TOPIC);

  mqttClient = mqtt.connect(MQTT_URL, {
    clientId: `smart-traffic-dashboard-${Math.random().toString(16).slice(2)}`,
    username: AIO_USERNAME,
    password: AIO_KEY,
    reconnectPeriod: 3000,
    connectTimeout: 15000,
    clean: true,
    rejectUnauthorized: true
  });

  mqttClient.on('connect', () => {
    console.log('Connected to Adafruit IO MQTT');
    mqttClient.subscribe(MQTT_TOPIC, { qos: 0 }, error => {
      if (error) console.error('MQTT subscribe error:', error.message);
      else console.log('Subscribed to Adafruit IO group:', MQTT_TOPIC);
    });
  });

  mqttClient.on('reconnect', () => console.log('Reconnecting to Adafruit IO...'));
  mqttClient.on('close', () => console.warn('Adafruit IO MQTT connection closed'));
  mqttClient.on('error', error => console.error('Adafruit IO MQTT error:', error.message));

  mqttClient.on('message', (_topic, packet) => {
    try {
      const parsed = JSON.parse(packet.toString());
      const telemetry = normalize(parsed);
      latest = telemetry;
      recentTelemetry.unshift(telemetry);
      if (recentTelemetry.length > 1000) recentTelemetry.pop();
      broadcast(telemetry);
      console.log('Adafruit IO telemetry received');
    } catch (error) {
      console.error('Invalid Adafruit IO telemetry:', error.message);
    }
  });
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mqtt: mqttClient?.connected ? 'connected' : 'disconnected',
    broker: 'Adafruit IO',
    telemetry_topic: MQTT_TOPIC || null,
    configured: Boolean(AIO_USERNAME && AIO_KEY),
    database: 'not configured'
  });
});

app.get('/api/latest', (_req, res) => {
  res.json(latest || { message: 'No Adafruit IO telemetry received yet' });
});

app.get('/api/telemetry', (req, res) => {
  const requested = Number.parseInt(req.query.limit, 10);
  const limit = Number.isInteger(requested) ? Math.max(1, Math.min(requested, 1000)) : 100;
  res.json(recentTelemetry.slice(0, limit));
});

app.get('/api/stats', (_req, res) => {
  if (!recentTelemetry.length) {
    return res.json({ samples: 0, avg_north_cm: 0, avg_east_cm: 0, max_north_count: 0, max_east_count: 0 });
  }
  const average = field => recentTelemetry.reduce((sum, item) => sum + Number(item[field] || 0), 0) / recentTelemetry.length;
  res.json({
    samples: recentTelemetry.length,
    avg_north_cm: Number(average('north_cm').toFixed(2)),
    avg_east_cm: Number(average('east_cm').toFixed(2)),
    max_north_count: Math.max(...recentTelemetry.map(item => item.north_count)),
    max_east_count: Math.max(...recentTelemetry.map(item => item.east_count))
  });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  if (latest) res.write(`data: ${JSON.stringify(latest)}\n\n`);
  req.on('close', () => clients.delete(res));
});

app.post('/api/control', (req, res) => {
  const { mode } = req.body || {};
  if (!['AUTO', 'MANUAL_NS', 'MANUAL_EW'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be AUTO, MANUAL_NS, or MANUAL_EW' });
  }
  if (!mqttClient?.connected) {
    return res.status(503).json({ error: 'Adafruit IO MQTT is disconnected' });
  }

  // The ESP32 firmware callback expects the command as plain text, not JSON.
  mqttClient.publish(MQTT_CONTROL_TOPIC, mode, { qos: 0 }, error => {
    if (error) return res.status(502).json({ error: error.message });
    return res.json({ ok: true, topic: MQTT_CONTROL_TOPIC, command: mode });
  });
});

startMqtt();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Smart Traffic dashboard listening on port ${PORT}`);
});

function shutdown() {
  if (mqttClient) mqttClient.end(true);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
