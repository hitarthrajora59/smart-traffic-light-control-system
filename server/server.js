import express from 'express';
import cors from 'cors';
import mqtt from 'mqtt';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// ============================================================
// SERVER CONFIG
// ============================================================

const PORT = process.env.PORT || 10000;


// ============================================================
// EMQX CLOUD MQTT CONFIG
// ============================================================

const MQTT_URL =
  process.env.MQTT_URL ||
  'mqtts://k662b704.ala.asia-southeast1.emqxsl.com:8883';

const MQTT_USERNAME =
  process.env.MQTT_USERNAME ||
  'traffic_user';

const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

const MQTT_TOPIC =
  process.env.MQTT_TOPIC ||
  'smart-traffic/+/telemetry';

const MQTT_CONTROL_TOPIC =
  process.env.MQTT_CONTROL_TOPIC ||
  'smart-traffic/control';


// ============================================================
// TELEMETRY STORAGE
// ============================================================

const clients = new Set();

const recentTelemetry = [];

let latest = null;


// ============================================================
// TELEMETRY VALIDATION
// ============================================================

function normalize(payload) {

  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new Error('Payload must be a JSON object');
  }


  const numeric = (
    value,
    field,
    min,
    max,
    integer = false
  ) => {

    if (
      (typeof value !== 'number' &&
        typeof value !== 'string') ||
      String(value).trim() === ''
    ) {
      throw new Error(`Invalid ${field}`);
    }

    const parsed = Number(value);

    if (
      !Number.isFinite(parsed) ||
      parsed < min ||
      parsed > max ||
      (integer && !Number.isInteger(parsed))
    ) {
      throw new Error(`Invalid ${field}`);
    }

    return parsed;
  };


  const northSignal =
    String(payload.ns_signal || '').toUpperCase();

  const eastSignal =
    String(payload.ew_signal || '').toUpperCase();

  const mode =
    String(payload.mode || '').toUpperCase();


  // Signal validation

  if (
    !['RED', 'YELLOW', 'GREEN'].includes(northSignal) ||
    !['RED', 'YELLOW', 'GREEN'].includes(eastSignal)
  ) {
    throw new Error('Invalid signal state');
  }


  // Both directions cannot be GREEN

  if (
    northSignal === 'GREEN' &&
    eastSignal === 'GREEN'
  ) {
    throw new Error('Conflicting GREEN signals');
  }


  // Operating mode

  if (
    !['AUTO', 'MANUAL_NS', 'MANUAL_EW'].includes(mode)
  ) {
    throw new Error('Invalid operating mode');
  }


  // Access status

  if (
    typeof payload.access_granted !== 'boolean'
  ) {
    throw new Error('Invalid access_granted status');
  }


  // Timestamp

  const rawTimestamp = payload.ts;

  const timestampValue =
    rawTimestamp === undefined ||
    rawTimestamp === null
      ? NaN
      : Number(rawTimestamp);


  const timestamp =
    Number.isFinite(timestampValue) &&
    /^\d+$/.test(String(rawTimestamp))

      ? timestampValue >= 1e12
        ? new Date(timestampValue)

        : timestampValue >= 1e9
          ? new Date(timestampValue * 1000)

          : new Date()

      : rawTimestamp
        ? new Date(rawTimestamp)

        : new Date();


  if (
    Number.isNaN(timestamp.getTime())
  ) {
    throw new Error('Invalid timestamp');
  }


  // Device ID

  const deviceId =
    payload.device_id ||
    payload.device;


  if (
    typeof deviceId !== 'string' ||
    !deviceId.trim() ||
    deviceId.length > 64
  ) {
    throw new Error('Invalid device_id');
  }


  // Final normalized object

  return {

    device_id: deviceId,

    ts: timestamp,

    north_cm: numeric(
      payload.north_cm ?? payload.north,
      'north_cm',
      0,
      450
    ),

    east_cm: numeric(
      payload.east_cm ?? payload.east,
      'east_cm',
      0,
      450
    ),

    north_count: numeric(
      payload.north_count,
      'north_count',
      0,
      10000,
      true
    ),

    east_count: numeric(
      payload.east_count,
      'east_count',
      0,
      10000,
      true
    ),

    ns_signal: northSignal,

    ew_signal: eastSignal,

    remaining_sec: numeric(
      payload.remaining_sec,
      'remaining_sec',
      0,
      3600,
      true
    ),

    mode,

    access_granted:
      payload.access_granted,

    raw: payload
  };
}


// ============================================================
// LIVE DASHBOARD BROADCAST
// ============================================================

function broadcast(t) {

  const msg =
    `data: ${JSON.stringify(t)}\n\n`;

  for (const res of clients) {
    res.write(msg);
  }
}


// ============================================================
// EMQX CLOUD MQTT CLIENT
// ============================================================

console.log('');
console.log('Connecting to EMQX Cloud...');
console.log('MQTT URL:', MQTT_URL);
console.log('MQTT User:', MQTT_USERNAME);
console.log('MQTT Topic:', MQTT_TOPIC);
console.log('');


const mqttClient = mqtt.connect(
  MQTT_URL,
  {

    clientId:
      `smart-traffic-dashboard-${Math.random()
        .toString(16)
        .slice(2)}`,

    username:
      MQTT_USERNAME,

    password:
      MQTT_PASSWORD,

    reconnectPeriod: 3000,

    connectTimeout: 10000,

    protocol: 'mqtts',

    rejectUnauthorized: true
  }
);


// ============================================================
// MQTT CONNECT
// ============================================================

mqttClient.on(
  'connect',
  () => {

    console.log(
      'MQTT connected:',
      MQTT_URL
    );

    mqttClient.subscribe(
      MQTT_TOPIC,
      { qos: 0 },
      err => {

        if (err) {

          console.error(
            'MQTT subscribe error:',
            err.message
          );

        } else {

          console.log(
            'MQTT subscribed:',
            MQTT_TOPIC
          );

        }
      }
    );
  }
);


// ============================================================
// MQTT ERROR
// ============================================================

mqttClient.on(
  'error',
  err => {

    console.error(
      'MQTT error:',
      err.message
    );
  }
);


// ============================================================
// MQTT MESSAGE
// ============================================================

mqttClient.on(
  'message',
  async (_topic, message) => {

    try {

      const payload =
        JSON.parse(
          message.toString()
        );


      const t =
        normalize(payload);


      latest = t;


      recentTelemetry.unshift(t);


      if (
        recentTelemetry.length > 100
      ) {
        recentTelemetry.pop();
      }


      broadcast(t);


    } catch (err) {

      console.error(
        'Invalid telemetry:',
        err.message
      );
    }
  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  (_req, res) => {

    res.json({

      ok: true,

      mqtt:
        mqttClient.connected
          ? 'connected'
          : 'disconnected'

    });
  }
);


// ============================================================
// LATEST TELEMETRY
// ============================================================

app.get(
  '/api/latest',
  (_req, res) => {

    res.json(
      latest || {
        message:
          'No telemetry received yet'
      }
    );
  }
);


// ============================================================
// TELEMETRY HISTORY
// ============================================================

app.get(
  '/api/telemetry',
  (req, res) => {

    const requestedLimit =
      Number.parseInt(
        req.query.limit,
        10
      );

    const limit =
      Number.isInteger(requestedLimit)
        ? Math.max(
            1,
            Math.min(
              requestedLimit,
              1000
            )
          )
        : 100;

    res.json(
      recentTelemetry.slice(
        0,
        limit
      )
    );
  }
);


// ============================================================
// STATISTICS
// ============================================================

app.get(
  '/api/stats',
  (_req, res) => {

    if (!recentTelemetry.length) {

      return res.json({
        samples: 0,
        avg_north_cm: 0,
        avg_east_cm: 0,
        max_north_count: 0,
        max_east_count: 0
      });
    }


    const samples =
      recentTelemetry;


    const average = field =>
      samples.reduce(
        (sum, item) =>
          sum + Number(
            item[field] || 0
          ),
        0
      ) / samples.length;


    res.json({

      samples:
        samples.length,

      avg_north_cm:
        Number(
          average('north_cm')
            .toFixed(2)
        ),

      avg_east_cm:
        Number(
          average('east_cm')
            .toFixed(2)
        ),

      max_north_count:
        Math.max(
          ...samples.map(
            item =>
              Number(
                item.north_count || 0
              )
          )
        ),

      max_east_count:
        Math.max(
          ...samples.map(
            item =>
              Number(
                item.east_count || 0
              )
          )
        )
    });
  }
);


// ============================================================
// SERVER-SENT EVENTS
// ============================================================

app.get(
  '/events',
  (req, res) => {

    res.setHeader(
      'Content-Type',
      'text/event-stream'
    );

    res.setHeader(
      'Cache-Control',
      'no-cache'
    );

    res.setHeader(
      'Connection',
      'keep-alive'
    );


    res.flushHeaders();


    clients.add(res);


    if (latest) {

      res.write(
        `data: ${JSON.stringify(latest)}\n\n`
      );
    }


    req.on(
      'close',
      () => {

        clients.delete(res);

      }
    );
  }
);


// ============================================================
// DASHBOARD CONTROL
// ============================================================

app.post(
  '/api/control',
  (req, res) => {

    if (
      !req.body ||
      ![
        'AUTO',
        'MANUAL_NS',
        'MANUAL_EW'
      ].includes(req.body.mode)
    ) {

      return res.status(400).json({

        error:
          'mode must be AUTO, MANUAL_NS, or MANUAL_EW'

      });
    }


    if (
      !mqttClient.connected
    ) {

      return res.status(503).json({

        error:
          'MQTT disconnected'

      });
    }


    mqttClient.publish(

      MQTT_CONTROL_TOPIC,

      JSON.stringify({

        ...req.body,

        source:
          'dashboard',

        ts:
          new Date().toISOString()

      })

    );


    res.json({
      ok: true
    });
  }
);


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `Dashboard running on port ${PORT}`
    );

  }
);