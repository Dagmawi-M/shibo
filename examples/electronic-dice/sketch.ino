// Electronic dice: press the button to roll. The digit spins, then stops on 1 to 6.
// A common-cathode seven-segment digit: segments A-G on pins 3-9, common pin to ground through 220 ohms.
const int BUTTON = 2;
const int SEGMENT_PINS[7] = {3, 4, 5, 6, 7, 8, 9};   // A B C D E F G
const byte DIGITS[7] = {           // bit 0 is segment A ... bit 6 is G
  0b0111111, 0b0000110, 0b1011011, 0b1001111, 0b1100110, 0b1101101, 0b1111101,
};

void show(int n) {
  for (int s = 0; s < 7; s++) digitalWrite(SEGMENT_PINS[s], (DIGITS[n] >> s) & 1);
}

void setup() {
  for (int s = 0; s < 7; s++) pinMode(SEGMENT_PINS[s], OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  Serial.begin(9600);
  show(0);
}

void loop() {
  if (digitalRead(BUTTON) == LOW) {
    randomSeed(micros());                 // how long you waited makes the roll
    for (int i = 0; i < 12; i++) { show(random(1, 7)); delay(40 + i * 10); }
    int roll = random(1, 7);
    show(roll);
    Serial.print("Rolled ");
    Serial.println(roll);
    while (digitalRead(BUTTON) == LOW) delay(10);   // wait for the button to be let go
    delay(50);
  }
}
