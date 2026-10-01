# Wokwi Simulation

This directory is the end-to-end networked prototype. It uses an ESP32 in Wokwi because Wokwi currently provides simulated Wi-Fi networking for ESP32, while the production embedded controller is specified as STM32F103C8. The STM32 control firmware is in `../stm32-reference/`.

## Run online
1. Create a new ESP32 Wokwi project.
2. Copy `sketch.ino`, `diagram.json`, and `libraries.txt` into it.
3. Start the simulation.
4. Open the Serial Monitor. The firmware publishes JSON telemetry every 2 seconds to `smart-traffic/demo/telemetry` on the public HiveMQ broker.
5. Change either HC-SR04 `distance` attribute to change its estimated vehicle count and adaptive green duration.
6. Enter `1234` on the keypad for PIN authorization, then use A/B/C for AUTO / NS / EW mode. Press the fingerprint button (keyboard shortcut F) for simulated biometric authorization.

The controller uses a yellow interval before changing direction and never enables both green outputs together. Enter `+` or `-` in the Serial Monitor to adjust the base green duration from 8 to 30 seconds; Preferences (ESP32 NVS) retains it across restarts. The dashboard's default subscription `smart-traffic/+/telemetry` includes the Wokwi demo topic; its control topic is `smart-traffic/control`.

If compiling in the Wokwi editor, add the libraries listed in `libraries.txt` when prompted. The local repository does not include an Arduino CLI build environment.

Wokwi's public Wi-Fi gateway supports outbound MQTT/HTTP for ESP32 projects. Do not put private credentials into a public Wokwi project.
