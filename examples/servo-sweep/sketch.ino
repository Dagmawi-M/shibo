// Servo sweep: the horn turns slowly from 0 to 180 degrees and back.
#include <Servo.h>

Servo servo;

void setup() {
  servo.attach(9);
  Serial.begin(9600);
}

void loop() {
  for (int angle = 0; angle <= 180; angle++) { servo.write(angle); delay(15); }
  Serial.println("180");
  for (int angle = 180; angle >= 0; angle--) { servo.write(angle); delay(15); }
  Serial.println("0");
}
