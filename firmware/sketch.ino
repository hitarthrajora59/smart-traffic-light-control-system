#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Keypad.h>
#include <Preferences.h>
#include "esp_log.h"

// =====================================================
// ADAFRUIT IO CONFIGURATION
// =====================================================

const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASS = "";

// SAFE CREDENTIAL PLACEHOLDERS
const char* AIO_USERNAME = "Name";
const char* AIO_KEY      = "Key";

const char* MQTT_HOST = "io.adafruit.com";
const int MQTT_PORT = 1883;

const char* GROUP_KEY = "smart-traffic";
const char* CONTROL_FEED = "control";

const unsigned long PUBLISH_INTERVAL_MS = 30000;
const unsigned long SENSE_INTERVAL_MS = 1000;
const unsigned long MQTT_RETRY_MS = 10000;

String TELEMETRY_TOPIC;
String CONTROL_TOPIC;

WiFiClient net;
PubSubClient mqtt(net);

LiquidCrystal_I2C lcd(0x27, 16, 2);
Preferences prefs;

// =====================================================
// HARDWARE PINS
// =====================================================

// Ultrasonic sensors
const int TRIG_N = 5;
const int ECHO_N = 34;

const int TRIG_E = 21;
const int ECHO_E = 35;

// Traffic signals
const int NS_R = 13;
const int NS_Y = 12;
const int NS_G = 14;

const int EW_R = 27;
const int EW_Y = 25;
const int EW_G = 19;

// TM1637 display
const int TM_CLK = 23;
const int TM_DIO = 22;

// Buzzer
const int BUZZER = 18;

// Authentication button
const int AUTH_BTN = 39;

// I2C LCD
const int LCD_SDA = 16;
const int LCD_SCL = 17;

// =====================================================
// KEYPAD
// =====================================================

const byte ROWS = 3;
const byte COLS = 4;

char keys[ROWS][COLS] = {
    {'1', '2', '3', 'A'},
    {'4', '5', '6', 'B'},
    {'7', '8', '9', 'C'}
};

byte rowPins[ROWS] = {36, 33, 26};
byte colPins[COLS] = {2, 4, 15, 32};

Keypad keypad = Keypad(
    makeKeymap(keys),
    rowPins,
    colPins,
    ROWS,
    COLS
);

// =====================================================
// SYSTEM STATE
// =====================================================

String pinBuffer = "";
String mode = "AUTO";

bool accessGranted = false;

int greenSeconds = 15;
int remaining = 15;

long distN = 400;
long distE = 400;

int northCount = 0;
int eastCount = 0;

bool nsGreen = true;

String pendingCommand = "";

unsigned long lastTick = 0;
unsigned long lastPublish = 0;

bool firstPublish = true;

// =====================================================
// BUZZER
// =====================================================

void beep(int ms, int freq = 2000) {
    unsigned long half = 500000UL / freq;
    unsigned long end = millis() + ms;

    while (millis() < end) {
        digitalWrite(BUZZER, HIGH);
        delayMicroseconds(half);

        digitalWrite(BUZZER, LOW);
        delayMicroseconds(half);
    }
}

// =====================================================
// TM1637 DISPLAY - BIT BANGING
// =====================================================

inline void tmDelay() {
    delayMicroseconds(5);
}

void tmStart() {
    digitalWrite(TM_DIO, HIGH);
    digitalWrite(TM_CLK, HIGH);

    tmDelay();

    digitalWrite(TM_DIO, LOW);

    tmDelay();

    digitalWrite(TM_CLK, LOW);
}

void tmStop() {
    digitalWrite(TM_CLK, LOW);
    digitalWrite(TM_DIO, LOW);

    tmDelay();

    digitalWrite(TM_CLK, HIGH);

    tmDelay();

    digitalWrite(TM_DIO, HIGH);
}

void tmWriteByte(uint8_t b) {
    for (int i = 0; i < 8; i++) {
        digitalWrite(TM_CLK, LOW);

        digitalWrite(TM_DIO, b & 1);

        tmDelay();

        b >>= 1;

        digitalWrite(TM_CLK, HIGH);

        tmDelay();
    }

    // ACK clock
    digitalWrite(TM_CLK, LOW);
    digitalWrite(TM_DIO, HIGH);

    tmDelay();

    digitalWrite(TM_CLK, HIGH);

    tmDelay();

    digitalWrite(TM_CLK, LOW);
}

const uint8_t segs[] = {
    0x3f, 0x06, 0x5b, 0x4f, 0x66,
    0x6d, 0x7d, 0x07, 0x7f, 0x6f
};

void displayNumber(int n) {
    n = max(0, min(99, n));

    tmStart();
    tmWriteByte(0x40);
    tmStop();

    tmStart();
    tmWriteByte(0xC0);

    tmWriteByte(segs[n / 10]);
    tmWriteByte(segs[n % 10]);

    tmWriteByte(0);
    tmWriteByte(0);

    tmStop();

    tmStart();
    tmWriteByte(0x88 | 7);
    tmStop();
}

// =====================================================
// TRAFFIC SENSING
// =====================================================

long distanceCm(int trig, int echo) {
    digitalWrite(trig, LOW);
    delayMicroseconds(2);

    digitalWrite(trig, HIGH);
    delayMicroseconds(10);

    digitalWrite(trig, LOW);

    long us = pulseIn(echo, HIGH, 30000);

    if (us == 0)
        return 400;

    return us / 58;
}

int trafficCount(long cm) {
    if (cm < 15)  return 8;
    if (cm < 30)  return 6;
    if (cm < 60)  return 4;
    if (cm < 100) return 2;

    return 0;
}

void readSensors() {
    distN = distanceCm(TRIG_N, ECHO_N);
    distE = distanceCm(TRIG_E, ECHO_E);

    northCount = trafficCount(distN);
    eastCount = trafficCount(distE);
}

// =====================================================
// TRAFFIC SIGNAL CONTROL
// =====================================================

void setSignals() {
    bool northSelected = nsGreen && mode != "MANUAL_EW";
    bool eastSelected = !nsGreen && mode != "MANUAL_NS";

    digitalWrite(NS_Y, LOW);
    digitalWrite(EW_Y, LOW);

    digitalWrite(NS_R, !northSelected);
    digitalWrite(EW_R, !eastSelected);

    digitalWrite(NS_G, northSelected);
    digitalWrite(EW_G, eastSelected);
}

int adaptiveDuration(bool northSouth) {
    int selected = northSouth ? northCount : eastCount;
    int other = northSouth ? eastCount : northCount;

    return constrain(
        greenSeconds + (selected - other) * 2,
        8,
        30
    );
}

void switchDirection(bool northSouth) {
    if (nsGreen != northSouth) {
        if (nsGreen) {
            digitalWrite(NS_G, LOW);
            digitalWrite(NS_Y, HIGH);
            digitalWrite(EW_R, HIGH);
        }
        else {
            digitalWrite(EW_G, LOW);
            digitalWrite(EW_Y, HIGH);
            digitalWrite(NS_R, HIGH);
        }

        delay(1200);

        nsGreen = northSouth;
    }

    remaining = adaptiveDuration(northSouth);

    setSignals();
}

// =====================================================
// LCD
// =====================================================

void updateLCD() {
    char line[17];

    snprintf(
        line,
        sizeof(line),
        "N:%-3ld E:%-3ldcm   ",
        distN,
        distE
    );

    lcd.setCursor(0, 0);
    lcd.print(line);

    snprintf(
        line,
        sizeof(line),
        "%s %2ds %-9s",
        nsGreen ? "NS" : "EW",
        remaining,
        mode.c_str()
    );

    lcd.setCursor(0, 1);
    lcd.print(line);
}

// =====================================================
// MQTT CALLBACK
// =====================================================

void mqttCallback(
    char* topic,
    byte* payload,
    unsigned int len
) {
    String msg = "";

    for (unsigned int i = 0; i < len; i++) {
        msg += (char)payload[i];
    }

    msg.trim();
    msg.toUpperCase();

    Serial.print("Adafruit IO command: ");
    Serial.println(msg);

    pendingCommand = msg;
}

// =====================================================
// REMOTE COMMAND HANDLER
// =====================================================

void handleRemoteCommand() {
    if (pendingCommand.length() == 0)
        return;

    String cmd = pendingCommand;
    pendingCommand = "";

    if (cmd == "MANUAL_NS") {
        mode = "MANUAL_NS";
        switchDirection(true);
    }
    else if (cmd == "MANUAL_EW") {
        mode = "MANUAL_EW";
        switchDirection(false);
    }
    else if (cmd == "AUTO") {
        mode = "AUTO";
    }

    setSignals();
    updateLCD();
}

// =====================================================
// WIFI
// =====================================================

void connectWiFi() {
    WiFi.mode(WIFI_STA);

    WiFi.begin(
        WIFI_SSID,
        WIFI_PASS,
        6
    );

    unsigned long t = millis();

    while (
        WiFi.status() != WL_CONNECTED &&
        millis() - t < 15000
    ) {
        delay(250);
        Serial.print(".");
    }

    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("WiFi connected");

        Serial.print("IP: ");
        Serial.println(WiFi.localIP());
    }
    else {
        Serial.println(
            "WiFi timeout (system keeps running offline)"
        );
    }
}

// =====================================================
// MQTT CONNECTION MANAGEMENT
// =====================================================

void maintainMQTT() {
    static unsigned long lastAttempt = 0;
    static bool first = true;

    if (mqtt.connected())
        return;

    if (
        !first &&
        millis() - lastAttempt < MQTT_RETRY_MS
    )
        return;

    first = false;
    lastAttempt = millis();

    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi not connected, retrying...");

        WiFi.disconnect();

        WiFi.begin(
            WIFI_SSID,
            WIFI_PASS,
            6
        );

        return;
    }

    String clientID =
        "ESP32-Traffic-" +
        String((uint32_t)ESP.getEfuseMac(), HEX);

    Serial.println("Connecting to Adafruit IO...");

    if (
        mqtt.connect(
            clientID.c_str(),
            AIO_USERNAME,
            AIO_KEY
        )
    ) {
        Serial.println("Adafruit IO MQTT connected");

        mqtt.subscribe(CONTROL_TOPIC.c_str());

        Serial.print("Subscribed to: ");
        Serial.println(CONTROL_TOPIC);
    }
    else {
        Serial.print("MQTT failed, state = ");
        Serial.println(mqtt.state());
    }
}

// =====================================================
// TELEMETRY PUBLISHING
// =====================================================

void publishTelemetry() {
    if (!mqtt.connected())
        return;

    char payload[400];

    // Correct JSON escaping
    snprintf(
        payload,
        sizeof(payload),
        "{\"feeds\":{"
        "\"north-cm\":%ld,"
        "\"east-cm\":%ld,"
        "\"north-count\":%d,"
        "\"east-count\":%d,"
        "\"ns-signal\":\"%s\","
        "\"ew-signal\":\"%s\","
        "\"remaining-sec\":%d,"
        "\"mode\":\"%s\","
        "\"access-granted\":%d"
        "}}",

        distN,
        distE,

        northCount,
        eastCount,

        nsGreen ? "GREEN" : "RED",
        nsGreen ? "RED" : "GREEN",

        remaining,

        mode.c_str(),

        accessGranted ? 1 : 0
    );

    bool ok = mqtt.publish(
        TELEMETRY_TOPIC.c_str(),
        payload
    );

    Serial.println(
        ok ? "Telemetry published:" :
             "Telemetry publishing failed"
    );

    Serial.println(payload);
}

// =====================================================
// SERIAL CONFIGURATION
// =====================================================

void handleSerialConfiguration() {
    while (Serial.available()) {
        char command = Serial.read();

        int updated =
            greenSeconds +
            (
                command == '+' ? 1 :
                command == '-' ? -1 :
                0
            );

        if (
            updated >= 8 &&
            updated <= 30 &&
            updated != greenSeconds
        ) {
            greenSeconds = updated;

            prefs.putInt("green", greenSeconds);

            Serial.printf(
                "Base green duration: %d seconds\n",
                greenSeconds
            );
        }
    }
}

// =====================================================
// KEYPAD + AUTHENTICATION
// =====================================================

void handleKeypad() {
    char k = keypad.getKey();

    if (!k)
        return;

    if (k >= '0' && k <= '9') {
        pinBuffer += k;

        if (pinBuffer.length() >= 4) {
            accessGranted = (pinBuffer == "1234");

            pinBuffer = "";

            if (accessGranted)
                beep(80, 2000);
            else
                beep(300, 400);

            Serial.println(
                accessGranted ?
                "Authentication successful" :
                "Authentication failed"
            );
        }
    }
    else if (accessGranted && k == 'A') {
        mode = "AUTO";

        Serial.println("AUTO mode selected");
    }
    else if (accessGranted && k == 'B') {
        mode = "MANUAL_NS";

        switchDirection(true);

        Serial.println("MANUAL NS selected");
    }
    else if (accessGranted && k == 'C') {
        mode = "MANUAL_EW";

        switchDirection(false);

        Serial.println("MANUAL EW selected");
    }
    else if (
        !accessGranted &&
        (k == 'A' || k == 'B' || k == 'C')
    ) {
        Serial.println("Locked: enter PIN first");
    }
}

// =====================================================
// AUTHENTICATION BUTTON
// =====================================================

void handleAuthButton() {
    static bool prev = HIGH;
    static unsigned long lastPress = 0;

    bool now = digitalRead(AUTH_BTN);

    if (
        prev == HIGH &&
        now == LOW &&
        millis() - lastPress > 200
    ) {
        lastPress = millis();

        accessGranted = true;

        beep(100, 2000);

        Serial.println(
            "Fingerprint authentication successful"
        );
    }

    prev = now;
}

// =====================================================
// SETUP
// =====================================================

void setup() {
    Serial.begin(115200);

    // Silence GPIO log spam caused by GPIO36 keypad row
    esp_log_level_set("gpio", ESP_LOG_NONE);

    // Connect WiFi
    connectWiFi();

    // Ultrasonic sensors
    pinMode(TRIG_N, OUTPUT);
    pinMode(ECHO_N, INPUT);

    pinMode(TRIG_E, OUTPUT);
    pinMode(ECHO_E, INPUT);

    // Traffic signals
    pinMode(NS_R, OUTPUT);
    pinMode(NS_Y, OUTPUT);
    pinMode(NS_G, OUTPUT);

    pinMode(EW_R, OUTPUT);
    pinMode(EW_Y, OUTPUT);
    pinMode(EW_G, OUTPUT);

    // Buzzer
    pinMode(BUZZER, OUTPUT);

    // Authentication button
    pinMode(AUTH_BTN, INPUT);

    // TM1637
    pinMode(TM_CLK, OUTPUT);
    pinMode(TM_DIO, OUTPUT);

    // LCD
    Wire.begin(LCD_SDA, LCD_SCL);

    lcd.init();
    lcd.backlight();

    // Persistent configuration
    prefs.begin("traffic", false);

    greenSeconds = prefs.getInt("green", 15);

    if (!prefs.isKey("green")) {
        prefs.putInt("green", greenSeconds);
    }

    remaining = greenSeconds;

    // Startup LCD
    lcd.print("SMART TRAFFIC");

    lcd.setCursor(0, 1);
    lcd.print("Initializing...");

    displayNumber(greenSeconds);

    setSignals();

    // Adafruit IO MQTT topics
    TELEMETRY_TOPIC =
        String(AIO_USERNAME) +
        "/groups/" +
        GROUP_KEY;

    CONTROL_TOPIC =
        String(AIO_USERNAME) +
        "/feeds/" +
        CONTROL_FEED;

    mqtt.setServer(
        MQTT_HOST,
        MQTT_PORT
    );

    mqtt.setCallback(mqttCallback);

    mqtt.setBufferSize(512);

    readSensors();

    Serial.println();
    Serial.println("SMART TRAFFIC SYSTEM READY");
}

// =====================================================
// MAIN LOOP
// =====================================================

void loop() {
    maintainMQTT();

    mqtt.loop();

    handleSerialConfiguration();

    handleRemoteCommand();

    handleKeypad();

    handleAuthButton();

    unsigned long now = millis();

    // 1 Hz sensing, countdown, and display update
    if (now - lastTick >= SENSE_INTERVAL_MS) {
        lastTick = now;

        readSensors();

        if (mode == "AUTO") {
            if (remaining > 0)
                remaining--;

            if (remaining == 0) {
                switchDirection(!nsGreen);
            }
        }

        setSignals();

        displayNumber(remaining);

        updateLCD();

        static int sec = 0;

        if (++sec >= 5) {
            sec = 0;

            Serial.printf(
                "N=%ldcm (%d veh)  "
                "E=%ldcm (%d veh)  "
                "%s green %ds  "
                "mode=%s  auth=%d\n",

                distN,
                northCount,

                distE,
                eastCount,

                nsGreen ? "NS" : "EW",

                remaining,

                mode.c_str(),

                accessGranted
            );
        }
    }

    // Adafruit IO telemetry
    if (
        mqtt.connected() &&
        (
            firstPublish ||
            now - lastPublish >= PUBLISH_INTERVAL_MS
        )
    ) {
        firstPublish = false;
        lastPublish = now;

        publishTelemetry();
    }
}