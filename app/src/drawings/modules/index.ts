// Drawings for the modules and comms parts.
import { breakout, dip } from './board.ts';

dip('shibo-74hc595', '74HC595', ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'GND', 'Q7S', 'MR', 'SHCP', 'STCP', 'OE', 'DS', 'Q0', 'VCC']);
dip('shibo-74hc165', '74HC165', ['PL', 'CP', 'D4', 'D5', 'D6', 'D7', 'Q7_N', 'GND', 'Q7', 'DS', 'D0', 'D1', 'D2', 'D3', 'CE', 'VCC']);
dip('shibo-cd4051', 'CD4051', ['Y4', 'Y6', 'COM', 'Y7', 'Y5', 'INH', 'VEE', 'GND', 'C', 'B', 'A', 'Y3', 'Y0', 'Y1', 'Y2', 'VCC']);
dip('shibo-eeprom-24c32', '24C32', ['A0', 'A1', 'A2', 'GND', 'SDA', 'SCL', 'WP', 'VCC']);
dip('shibo-pcf8574', 'PCF8574', ['A0', 'A1', 'A2', 'P0', 'P1', 'P2', 'P3', 'GND', 'P4', 'P5', 'P6', 'P7', 'INT', 'SCL', 'SDA', 'VCC']);
breakout('shibo-ds3231', { title: 'DS3231 RTC', pins: ['32K', 'SQW', 'SCL', 'SDA', 'VCC', 'GND'], color: '#1d4f91', width: 80, height: 70,
  art: '<rect x="14" y="18" width="26" height="20" rx="1" fill="#222"/><circle cx="60" cy="32" r="14" fill="#c9c9c9" stroke="#888"/><text x="60" y="35" font-size="6" text-anchor="middle" fill="#555">CR2032</text>' });
