// RGB mood light: fades smoothly round the colour wheel, red to green to blue and back to red.
const int RED = 9, GREEN = 10, BLUE = 11;     // all three can do PWM

void colour(int r, int g, int b) {
  analogWrite(RED, r);
  analogWrite(GREEN, g);
  analogWrite(BLUE, b);
}

void setup() {
  Serial.begin(9600);
}

void loop() {
  for (int i = 0; i < 255; i += 5) { colour(255 - i, i, 0); delay(20); }
  Serial.println("green");
  for (int i = 0; i < 255; i += 5) { colour(0, 255 - i, i); delay(20); }
  Serial.println("blue");
  for (int i = 0; i < 255; i += 5) { colour(i, 0, 255 - i); delay(20); }
  Serial.println("red");
}
