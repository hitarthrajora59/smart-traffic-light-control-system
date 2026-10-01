/* STM32F103C8 production-target reference logic.
 * Port the pin map to the final PCB in STM32CubeIDE/PlatformIO.
 * Wokwi's current multi-MCU limitation means this target is kept separate from the ESP32 MQTT gateway simulation.
 */
#include <Arduino.h>

const uint8_t NS_R=PB0, NS_Y=PB1, NS_G=PB10;
const uint8_t EW_R=PB11, EW_Y=PB12, EW_G=PB13;
const uint8_t TRIG_N=PA0, ECHO_N=PA1, TRIG_E=PA2, ECHO_E=PA3;
const int BASE_GREEN_SECONDS=15;
bool nsGreen=true;
unsigned long phaseStarted=0;

long distanceCm(uint8_t trig,uint8_t echo){
  digitalWrite(trig,LOW); delayMicroseconds(2); digitalWrite(trig,HIGH); delayMicroseconds(10); digitalWrite(trig,LOW);
  long us=pulseIn(echo,HIGH,30000); return us?us/58:400;
}
int trafficCount(long cm){if(cm<15)return 8;if(cm<30)return 6;if(cm<60)return 4;if(cm<100)return 2;return 0;}
int adaptiveDuration(bool northSouth,int northCount,int eastCount){
  int difference=northSouth?northCount-eastCount:eastCount-northCount;
  return constrain(BASE_GREEN_SECONDS+difference*2,8,30);
}
void setNS(){digitalWrite(EW_G,LOW);digitalWrite(NS_G,LOW);digitalWrite(NS_R,LOW);digitalWrite(EW_R,HIGH);digitalWrite(NS_G,HIGH);}
void setEW(){digitalWrite(NS_G,LOW);digitalWrite(EW_G,LOW);digitalWrite(NS_R,HIGH);digitalWrite(EW_R,LOW);digitalWrite(EW_G,HIGH);}
void switchPhase(bool northSouth){
  if(nsGreen){digitalWrite(NS_G,LOW);digitalWrite(NS_Y,HIGH);digitalWrite(EW_R,HIGH);}
  else{digitalWrite(EW_G,LOW);digitalWrite(EW_Y,HIGH);digitalWrite(NS_R,HIGH);}
  delay(1200);
  digitalWrite(NS_Y,LOW);digitalWrite(EW_Y,LOW);
  nsGreen=northSouth;
  if(nsGreen)setNS();else setEW();
  phaseStarted=millis();
}
void setup(){Serial.begin(115200);pinMode(NS_R,OUTPUT);pinMode(NS_Y,OUTPUT);pinMode(NS_G,OUTPUT);pinMode(EW_R,OUTPUT);pinMode(EW_Y,OUTPUT);pinMode(EW_G,OUTPUT);pinMode(TRIG_N,OUTPUT);pinMode(ECHO_N,INPUT);pinMode(TRIG_E,OUTPUT);pinMode(ECHO_E,INPUT);setNS();phaseStarted=millis();}
void loop(){
  long n=distanceCm(TRIG_N,ECHO_N), e=distanceCm(TRIG_E,ECHO_E);
  int northCount=trafficCount(n),eastCount=trafficCount(e);
  unsigned long phaseLength=(unsigned long)adaptiveDuration(nsGreen,northCount,eastCount)*1000;
  if(millis()-phaseStarted>=phaseLength)switchPhase(!nsGreen);
  Serial.printf("N=%ld,E=%ld,N-count=%d,E-count=%d,NS=%s,EW=%s\n",n,e,northCount,eastCount,nsGreen?"GREEN":"RED",nsGreen?"RED":"GREEN");
  delay(1000);
}
