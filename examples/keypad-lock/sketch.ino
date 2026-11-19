// Keypad lock: type 1234 and press # to unlock. * clears what you typed.
// The green LED shows "open" for two seconds; a wrong code flashes the red one.
#include <Keypad.h>

const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'},
};
byte rowPins[ROWS] = {9, 8, 7, 6};
byte colPins[COLS] = {5, 4, 3, 2};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

const int OPEN_LED = 10, LOCKED_LED = 11;
const String CODE = "1234";
String typed = "";

void setup() {
  pinMode(OPEN_LED, OUTPUT);
  pinMode(LOCKED_LED, OUTPUT);
  digitalWrite(LOCKED_LED, HIGH);
  Serial.begin(9600);
  Serial.println("Locked. Enter the code and press #");
}

void loop() {
  char key = keypad.getKey();
  if (!key) return;
  if (key == '*') {
    typed = "";
    Serial.println();
    Serial.println("Cleared");
  } else if (key == '#') {
    Serial.println();
    if (typed == CODE) {
      Serial.println("Unlocked");
      digitalWrite(LOCKED_LED, LOW);
      digitalWrite(OPEN_LED, HIGH);
      delay(2000);
      digitalWrite(OPEN_LED, LOW);
      Serial.println("Locked");
    } else {
      Serial.println("Wrong code");
      for (int i = 0; i < 3; i++) { digitalWrite(LOCKED_LED, LOW); delay(150); digitalWrite(LOCKED_LED, HIGH); delay(150); }
    }
    digitalWrite(LOCKED_LED, HIGH);
    typed = "";
  } else {
    typed += key;
    Serial.print('*');
  }
}
