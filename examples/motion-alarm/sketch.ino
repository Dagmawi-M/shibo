// Motion alarm: when the PIR sensor sees movement, the LED lights and the buzzer sounds.
const int PIR = 2, LED = 13, BUZZER = 8;
bool alarm = false;

void setup() {
  pinMode(PIR, INPUT);
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
  Serial.println("Watching");
}

void loop() {
  bool motion = digitalRead(PIR) == HIGH;
  if (motion && !alarm) {
    alarm = true;
    digitalWrite(LED, HIGH);
    tone(BUZZER, 2000);
    Serial.println("Motion detected!");
  } else if (!motion && alarm) {
    alarm = false;
    digitalWrite(LED, LOW);
    noTone(BUZZER);
    Serial.println("All clear");
  }
  delay(50);
}
