#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Keypad.h>
#include <Preferences.h>

// Smart Traffic Light Control System - Wokwi end-to-end IoT prototype
// ESP32 is used only for Wokwi network simulation. The STM32 control logic is documented separately.

const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASS = "";
const char* MQTT_HOST = "broker.hivemq.com";
const int MQTT_PORT = 1883;
const char* MQTT_TOPIC = "smart-traffic/demo/telemetry";
const char* CONTROL_TOPIC = "smart-traffic/control";

WiFiClient net;
PubSubClient mqtt(net);
LiquidCrystal_I2C lcd(0x27, 16, 2);
Preferences prefs;

const int TRIG_N=5, ECHO_N=34, TRIG_E=21, ECHO_E=35;
const int NS_R=13, NS_Y=12, NS_G=14, EW_R=27, EW_Y=25, EW_G=19;
const int TM_CLK=23, TM_DIO=22;
const int BUZZER=18;
const int AUTH_BTN=3;

const byte ROWS=3, COLS=4;
char keys[ROWS][COLS]={{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'}};
byte rowPins[ROWS]={32,33,26};
byte colPins[COLS]={2,4,15,0};
Keypad keypad=Keypad(makeKeymap(keys),rowPins,colPins,ROWS,COLS);

String pinBuffer="";
String mode="AUTO";
bool accessGranted=false;
int greenSeconds=15;
int remaining=15;
int northCount=0,eastCount=0;
bool nsGreen=true;
unsigned long lastTick=0,lastPublish=0;

void tmStart(){digitalWrite(TM_DIO,HIGH);digitalWrite(TM_CLK,HIGH);digitalWrite(TM_DIO,LOW);digitalWrite(TM_CLK,LOW);}
void tmStop(){digitalWrite(TM_CLK,LOW);digitalWrite(TM_DIO,LOW);digitalWrite(TM_CLK,HIGH);digitalWrite(TM_DIO,HIGH);}
void tmWriteByte(uint8_t b){for(int i=0;i<8;i++){digitalWrite(TM_CLK,LOW);digitalWrite(TM_DIO,b&1);b>>=1;digitalWrite(TM_CLK,HIGH);}digitalWrite(TM_CLK,LOW);digitalWrite(TM_DIO,HIGH);digitalWrite(TM_CLK,HIGH);digitalWrite(TM_CLK,LOW);}
const uint8_t segs[]={0x3f,0x06,0x5b,0x4f,0x66,0x6d,0x7d,0x07,0x7f,0x6f};
void displayNumber(int n){n=max(0,min(99,n));tmStart();tmWriteByte(0x40);tmStop();tmStart();tmWriteByte(0xC0);tmWriteByte(segs[n/10]);tmWriteByte(segs[n%10]);tmWriteByte(0);tmWriteByte(0);tmStop();tmStart();tmWriteByte(0x88|7);tmStop();}

long distanceCm(int trig,int echo){digitalWrite(trig,LOW);delayMicroseconds(2);digitalWrite(trig,HIGH);delayMicroseconds(10);digitalWrite(trig,LOW);long us=pulseIn(echo,HIGH,30000);if(us==0)return 400;return us/58;}
int trafficCount(long cm){if(cm<15)return 8;if(cm<30)return 6;if(cm<60)return 4;if(cm<100)return 2;return 0;}

void setSignals(){
  bool northSelected=nsGreen&&mode!="MANUAL_EW";
  bool eastSelected=!nsGreen&&mode!="MANUAL_NS";
  digitalWrite(NS_G,LOW); digitalWrite(EW_G,LOW);
  digitalWrite(NS_Y,LOW); digitalWrite(EW_Y,LOW);
  digitalWrite(NS_R,!northSelected); digitalWrite(EW_R,!eastSelected);
  digitalWrite(NS_G,northSelected); digitalWrite(EW_G,eastSelected);
}
int adaptiveDuration(bool northSouth){
  int selected=northSouth?northCount:eastCount;
  int other=northSouth?eastCount:northCount;
  return constrain(greenSeconds+(selected-other)*2,8,30);
}
void switchDirection(bool northSouth){
  if(nsGreen){digitalWrite(NS_G,LOW);digitalWrite(NS_Y,HIGH);digitalWrite(EW_R,HIGH);}
  else{digitalWrite(EW_G,LOW);digitalWrite(EW_Y,HIGH);digitalWrite(NS_R,HIGH);}
  delay(1200);
  nsGreen=northSouth;remaining=adaptiveDuration(northSouth);setSignals();
}
void lcdStatus(long n,long e){lcd.clear();lcd.setCursor(0,0);lcd.print("N:");lcd.print(n);lcd.print(" E:");lcd.print(e);lcd.print("cm");lcd.setCursor(0,1);lcd.print(nsGreen?"NS GREEN ":"EW GREEN ");lcd.print(remaining);}

void mqttCallback(char* topic,byte* payload,unsigned int len){String msg;for(unsigned int i=0;i<len;i++)msg+=(char)payload[i];if(msg.indexOf("MANUAL_NS")>=0){mode="MANUAL_NS";switchDirection(true);}else if(msg.indexOf("MANUAL_EW")>=0){mode="MANUAL_EW";switchDirection(false);}else if(msg.indexOf("AUTO")>=0){mode="AUTO";}setSignals();}

void connectWiFi(){WiFi.begin(WIFI_SSID,WIFI_PASS,6);unsigned long t=millis();while(WiFi.status()!=WL_CONNECTED&&millis()-t<15000){delay(250);Serial.print('.');}Serial.println(WiFi.status()==WL_CONNECTED?" WiFi OK":" WiFi timeout");}
void connectMQTT(){while(!mqtt.connected()){String id="wokwi-traffic-"+String((uint32_t)ESP.getEfuseMac(),HEX);if(mqtt.connect(id.c_str())){mqtt.subscribe(CONTROL_TOPIC);Serial.println("MQTT connected");}else{delay(1000);}}}
void handleSerialConfiguration(){
  while(Serial.available()){
    char command=Serial.read();
    int updated=greenSeconds+(command=='+'?1:command=='-'?-1:0);
    if(updated>=8&&updated<=30&&updated!=greenSeconds){greenSeconds=updated;prefs.putInt("green",greenSeconds);Serial.printf("Base green duration: %d seconds\n",greenSeconds);}
  }
}
void publishTelemetry(long n,long e){if(!mqtt.connected())return;String json="{";json+="\"device_id\":\"wokwi-esp32\",";json+="\"ts\":\""+String(millis())+"\",";json+="\"north_cm\":"+String(n)+",";json+="\"east_cm\":"+String(e)+",";json+="\"north_count\":"+String(trafficCount(n))+",";json+="\"east_count\":"+String(trafficCount(e))+",";json+="\"ns_signal\":\""+(nsGreen?String("GREEN"):String("RED"))+"\",";json+="\"ew_signal\":\""+(nsGreen?String("RED"):String("GREEN"))+"\",";json+="\"remaining_sec\":"+String(remaining)+",";json+="\"mode\":\""+mode+"\",";json+="\"access_granted\":"+(accessGranted?String("true"):String("false"))+"}";mqtt.publish(MQTT_TOPIC,json.c_str());Serial.println(json);}

void setup(){Serial.begin(115200);pinMode(TRIG_N,OUTPUT);pinMode(ECHO_N,INPUT);pinMode(TRIG_E,OUTPUT);pinMode(ECHO_E,INPUT);pinMode(NS_R,OUTPUT);pinMode(NS_Y,OUTPUT);pinMode(NS_G,OUTPUT);pinMode(EW_R,OUTPUT);pinMode(EW_Y,OUTPUT);pinMode(EW_G,OUTPUT);pinMode(BUZZER,OUTPUT);pinMode(AUTH_BTN,INPUT_PULLUP);pinMode(TM_CLK,OUTPUT);pinMode(TM_DIO,OUTPUT);
  Wire.begin(16,17);lcd.init();lcd.backlight();prefs.begin("traffic",false);greenSeconds=prefs.getInt("green",15);if(!prefs.isKey("green"))prefs.putInt("green",greenSeconds);lcd.print("SMART TRAFFIC");lcd.setCursor(0,1);lcd.print("Initializing...");displayNumber(greenSeconds);setSignals();connectWiFi();mqtt.setServer(MQTT_HOST,MQTT_PORT);mqtt.setCallback(mqttCallback);delay(500);}

void loop(){if(!mqtt.connected())connectMQTT();mqtt.loop();handleSerialConfiguration();
  char k=keypad.getKey();if(k){if(k>='0'&&k<='9'){pinBuffer+=k;if(pinBuffer.length()>=4){accessGranted=(pinBuffer=="1234");pinBuffer="";digitalWrite(BUZZER,HIGH);delay(80);digitalWrite(BUZZER,LOW);}}else if(k=='A'&&accessGranted){mode="AUTO";}else if(k=='B'&&accessGranted){mode="MANUAL_NS";switchDirection(true);}else if(k=='C'&&accessGranted){mode="MANUAL_EW";switchDirection(false);}}
  if(digitalRead(AUTH_BTN)==LOW){accessGranted=true;digitalWrite(BUZZER,HIGH);delay(100);digitalWrite(BUZZER,LOW);}
  if(millis()-lastTick>=1000){lastTick=millis();if(mode=="AUTO"&&remaining>0)remaining--;if(mode=="AUTO"&&remaining==0)switchDirection(!nsGreen);setSignals();displayNumber(remaining);}
  static long n=100,e=100;if(millis()-lastPublish>=2000){lastPublish=millis();n=distanceCm(TRIG_N,ECHO_N);e=distanceCm(TRIG_E,ECHO_E);northCount=trafficCount(n);eastCount=trafficCount(e);lcdStatus(n,e);publishTelemetry(n,e);}
}
