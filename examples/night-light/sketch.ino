// Night light: the lamp fades up as the room gets dark.
// The light sensor module gives a higher voltage on AO when it is darker.
const int SENSOR = A0, LAMP = 9;
const int DARK = 700, BRIGHT = 400;      // readings for "fully dark" and "light enough"

void setup() {
  pinMode(LAMP, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  int reading = analogRead(SENSOR);
  int level = constrain(map(reading, BRIGHT, DARK, 0, 255), 0, 255);
  analogWrite(LAMP, level);
  Serial.print("light reading ");
  Serial.print(reading);
  Serial.print(", lamp ");
  Serial.println(level);
  delay(200);
}
