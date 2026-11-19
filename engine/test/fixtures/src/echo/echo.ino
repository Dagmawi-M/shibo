void setup() { Serial.begin(9600); pinMode(2, INPUT_PULLUP); }
void loop() { if (Serial.available()) Serial.write(Serial.read()); }
