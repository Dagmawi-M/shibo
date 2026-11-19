// LED dimmer: turn the knob to set how bright the LED is.
const int KNOB = A0, LAMP = 9;               // pin 9 can do PWM

void setup() {
  pinMode(LAMP, OUTPUT);
}

void loop() {
  analogWrite(LAMP, analogRead(KNOB) / 4);   // 0..1023 in, 0..255 out
  delay(10);
}
