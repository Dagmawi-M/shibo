// The Arduino libraries a sketch may ask for, by the header it includes, under
// the names Arduino's library manager knows them by. Every header Shibo itself
// can write into a sketch is here (a test checks that), so a missing one can
// be named and installed with one click.

/** Header -> the library that provides it. */
export const LIBRARIES: Record<string, string> = {
  'Servo.h': 'Servo',
  'LiquidCrystal.h': 'LiquidCrystal',
  'LiquidCrystal_I2C.h': 'LiquidCrystal I2C',
  'Stepper.h': 'Stepper',
  'SD.h': 'SD',
  'Keypad.h': 'Keypad',
  'LedControl.h': 'LedControl',
  'MFRC522.h': 'MFRC522',
  'RF24.h': 'RF24',
  'RTClib.h': 'RTClib',
  'TinyGPSPlus.h': 'TinyGPSPlus',
  'TM1637Display.h': 'TM1637',
  'IRremote.hpp': 'IRremote',
  'IRremote.h': 'IRremote',
  'HX711.h': 'HX711 Arduino Library',
  'DHT.h': 'DHT sensor library',
  'DallasTemperature.h': 'DallasTemperature',
  'OneWire.h': 'OneWire',
  'BH1750.h': 'BH1750',
  'Adafruit_Sensor.h': 'Adafruit Unified Sensor',
  'Adafruit_SSD1306.h': 'Adafruit SSD1306',
  'Adafruit_GFX.h': 'Adafruit GFX Library',
  'Adafruit_NeoPixel.h': 'Adafruit NeoPixel',
  'Adafruit_ILI9341.h': 'Adafruit ILI9341',
  'Adafruit_INA219.h': 'Adafruit INA219',
  'Adafruit_SHT31.h': 'Adafruit SHT31 Library',
  'Adafruit_BMP280.h': 'Adafruit BMP280 Library',
  'Adafruit_BME280.h': 'Adafruit BME280 Library',
};

/** Headers that come with the board package or the C library; a name ending in "/" stands for the whole folder. */
export const BUNDLED: string[] = ['Arduino.h', 'Wire.h', 'SPI.h', 'EEPROM.h', 'SoftwareSerial.h', 'HID.h', 'avr/', 'util/',
  'math.h', 'stdio.h', 'stdlib.h', 'string.h', 'stdint.h', 'stdbool.h', 'stddef.h', 'ctype.h', 'limits.h', 'float.h'];
