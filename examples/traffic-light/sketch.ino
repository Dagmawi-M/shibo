// Traffic light: red for 3 seconds, green for 3, yellow for 1, then red again.
// Each LED is wired through a 220 ohm resistor to ground.
const int RED = 12, YELLOW = 11, GREEN = 10;

void show(bool red, bool yellow, bool green, const char *name, unsigned long ms) {
  digitalWrite(RED, red);
  digitalWrite(YELLOW, yellow);
  digitalWrite(GREEN, green);
  Serial.println(name);
  delay(ms);
}

void setup() {
  pinMode(RED, OUTPUT);
  pinMode(YELLOW, OUTPUT);
  pinMode(GREEN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  show(true, false, false, "red", 3000);
  show(false, false, true, "green", 3000);
  show(false, true, false, "yellow", 1000);
}
