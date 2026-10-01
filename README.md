# Smart Traffic Light Control System — 3rd Year IoT Project

## Deliverables
- `wokwi/` — ESP32 Wokwi end-to-end network simulation: ultrasonic sensors, traffic LEDs, LCD, TM1637 7-segment, keypad, buzzer and simulated fingerprint-success button.
- `stm32-reference/` — STM32F103C8 target-reference traffic-control firmware.
- `server/` — Node.js/Express MQTT subscriber, PostgreSQL logger, REST API and live dashboard.
- `database/schema.sql` — PostgreSQL telemetry schema.
- `render.yaml` — Render Web Service + PostgreSQL definition.
- `docs/` — SRS report in PDF and editable DOCX.

## Architecture decision
Wokwi supports STM32F103C8 and ESP32, but currently does not support multiple microcontrollers in one simulation. Therefore STM32 is the intended traffic-control target, while the Wokwi end-to-end MQTT/Wi-Fi demonstration uses ESP32 as the networked prototype.

## MQTT
Default Wokwi demo topic: `smart-traffic/demo/telemetry`.
Dashboard subscription: `smart-traffic/+/telemetry`.
Dashboard control topic: `smart-traffic/control`.
For real deployment, use an authenticated broker and set `MQTT_URL`, `MQTT_TOPIC`, and `MQTT_CONTROL_TOPIC` in Render.

## Run dashboard locally
Prerequisites: Node.js 20 LTS or newer and npm. From PowerShell:

```bash
cd server
npm install
# DATABASE_URL is optional for a dashboard-only run. Without it, DB logging waits
# for configuration and recent MQTT samples remain available in memory.
$env:PORT = "10000"
$env:MQTT_URL = "mqtt://broker.hivemq.com:1883"
$env:MQTT_TOPIC = "smart-traffic/+/telemetry"
$env:MQTT_CONTROL_TOPIC = "smart-traffic/control"
# Optional PostgreSQL connection string; do not commit credentials.
# $env:DATABASE_URL = "postgresql://USER:PASSWORD@HOST:5432/DATABASE"
npm start
```

Open `http://localhost:10000` and check `http://localhost:10000/health`. The dashboard uses SSE for live telemetry and polls health every five seconds. With PostgreSQL configured, the server creates the telemetry table automatically; `database/schema.sql` is also provided for manual setup.

MQTT environment variables are `MQTT_URL`, `MQTT_TOPIC`, and `MQTT_CONTROL_TOPIC`. The demo defaults use the public HiveMQ broker and are for simulation only. Use a private authenticated broker for deployment and store its URL/credentials only in environment settings.

## Build the STM32 reference
Install PlatformIO Core, then run this from `stm32-reference/`:

```bash
pio run
```

This reference targets the Blue Pill STM32F103C8. Wokwi uses the ESP32 networked prototype because one simulation cannot host both controllers.

## Render + GitHub
1. Push the project folder to a GitHub repository.
2. In Render, choose **New > Blueprint** and select the repository containing `render.yaml`.
3. Set `MQTT_URL` to your broker URL; configure `MQTT_TOPIC` and `MQTT_CONTROL_TOPIC` if using non-default topics. Keep broker credentials in Render environment settings.
4. Render provisions PostgreSQL and supplies `DATABASE_URL` from the blueprint.
5. Open the generated `onrender.com` URL and verify `/health` reports the expected MQTT and database states.

## Wokwi controls
- Change HC-SR04 distance values to demonstrate traffic density.
- Press `F` for simulated fingerprint authorization.
- Enter `1234` for PIN authorization.
- Use A/B/C for AUTO / NS / EW mode after authorization.
