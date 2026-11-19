// Servo knob: the servo follows the potentiometer.
#include <Servo.h>

Servo servo;
const int KNOB = A0;

void setup() {
  servo.attach(9);
}

void loop() {
  int reading = analogRead(KNOB);            // 0 to 1023
  servo.write(map(reading, 0, 1023, 0, 180)); // 0 to 180 degrees
  delay(15);
}
