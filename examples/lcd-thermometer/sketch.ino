// Thermometer: reads an NTC thermistor and shows the temperature on a 16x2 LCD.
#include <LiquidCrystal.h>
#include <math.h>

LiquidCrystal lcd(12, 11, 5, 4, 3, 2);   // RS, E, D4, D5, D6, D7
const int SENSOR = A0;
const float BETA = 3950;                 // the thermistor's beta coefficient

void setup() {
  lcd.begin(16, 2);
  lcd.print("Thermometer");
  Serial.begin(9600);
}

void loop() {
  int reading = analogRead(SENSOR);
  float celsius = 1 / (log(1 / (1023.0 / reading - 1)) / BETA + 1.0 / 298.15) - 273.15;
  lcd.setCursor(0, 1);
  lcd.print("Temp: ");
  lcd.print(celsius, 1);
  lcd.print(" C   ");
  Serial.println(celsius, 1);
  delay(250);
}
