// OLED clock: reads the time from a DS1307 real-time clock and shows it on an SSD1306 OLED.
#include <Wire.h>
#include <RTClib.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

RTC_DS1307 rtc;
Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  Serial.begin(9600);
  if (!rtc.begin()) { Serial.println("No clock found"); while (true) {} }
  if (!rtc.isrunning()) rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { Serial.println("No display found"); while (true) {} }
  display.setTextColor(SSD1306_WHITE);
}

void loop() {
  DateTime now = rtc.now();
  char time[9];
  snprintf(time, sizeof time, "%02d:%02d:%02d", now.hour(), now.minute(), now.second());
  display.clearDisplay();
  display.setTextSize(2);
  display.setCursor(16, 24);
  display.print(time);
  display.display();
  Serial.println(time);
  delay(1000);
}
