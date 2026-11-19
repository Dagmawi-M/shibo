// Distance alarm: beeps and lights the LED when something is closer than 30 cm.
const int TRIG = 9, ECHO = 10, BUZZER = 8, LED = 7;
const int NEAR_CM = 30;

void setup() {
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);              // a 10 us pulse starts a measurement
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long us = pulseIn(ECHO, HIGH, 30000);  // the echo lasts 58 us per centimetre
  int cm = us / 58;

  Serial.print("Distance: ");
  Serial.print(cm);
  Serial.println(" cm");
  if (cm > 0 && cm < NEAR_CM) {
    digitalWrite(LED, HIGH);
    tone(BUZZER, 1000);
  } else {
    digitalWrite(LED, LOW);
    noTone(BUZZER);
  }
  delay(100);
}
