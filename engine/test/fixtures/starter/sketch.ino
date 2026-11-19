// Starter: button toggles LED, prints to Serial
const int LED = 13, BTN = 2;
bool on = false;
void setup() { pinMode(LED, OUTPUT); pinMode(BTN, INPUT_PULLUP); Serial.begin(9600); Serial.println("Ready"); }
void loop() {
  if (digitalRead(BTN) == LOW) { on = !on; digitalWrite(LED, on); Serial.println(on ? "LED ON" : "LED OFF"); delay(250); }
}
