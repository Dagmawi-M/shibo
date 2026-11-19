# Shibo

**Shibo** (ሽቦ, Amharic for "wire") is an offline circuit simulator for Arduino sketches. Place parts, wire them, and run your real compiled sketch, before you buy anything. It runs as a VS Code extension and as a local web app, and nothing leaves your computer.

![The Shibo editor running a sketch that drives an LCD, an OLED and a servo](extension/images/screenshot.png)

## What it does

- **A catalog of parts** with pictures, grouped and searchable. Drag one onto the canvas, or click it.
- **Easy wiring:** drag from pin to pin, or click one pin and then another. Right-click to remove, Ctrl+Z to undo.
- **Circuit before code:** build the circuit first, then let Shibo write a starter sketch with a named pin for everything you wired.
- **Runs your real sketch:** the same compiled program that would go on the board, on an emulated ATmega328P. Save the sketch while it runs and it uploads again.
- **Behaves like the bench:** press buttons, turn knobs, set what each sensor senses with a slider. Displays show what your sketch draws.
- **Catches wiring mistakes:** an LED with no resistor, a floating button input, a relay driven straight from a pin, shorted outputs, a sensor with no power.
- **Checks the electrics** with [ngspice](https://ngspice.sourceforge.io/) while it runs: pin current over 20 mA (40 mA absolute), LED current too high or too low for its resistor, 5 V into a 3.3 V part, and how much each supply rail is asked for. Rest the pointer on a wire to read its voltage and current. Without ngspice (set `SHIBO_NGSPICE` to its path, or put it on the PATH) parts show as unchecked.
- **Prints a wiring guide:** what to buy and every connection, with a box to tick as you build.

## Parts

- **Boards:** Arduino Uno, Arduino Nano.
- **Lights and sound:** LED, RGB LED, LED bar graph, 7-segment display, Buzzer.
- **Basics:** Resistor.
- **Switches and knobs:** Push button, Push button (small), Slide switch, Potentiometer, DIP switch (8), Keypad, Joystick, Slide potentiometer, Rotary encoder.
- **Motors and switching:** Relay, Servo motor, Stepper motor, Two-hand stepper (clock).
- **Sensors:** Light sensor (LDR), Temperature sensor (NTC), Gas sensor, Flame sensor, Sound sensor (large), Sound sensor (small), Motion sensor (PIR), Tilt switch, Heartbeat sensor, Ultrasonic distance (HC-SR04), Temperature and humidity (DHT22), Infrared receiver, Load cell amplifier (HX711), Accelerometer and gyro (MPU6050).
- **Modules:** Infrared remote, Rotary phone dial, Real-time clock (DS1307).
- **Displays:** LCD 16x2, LCD 20x4, OLED display (SSD1306), NeoPixel LED, NeoPixel ring, NeoPixel matrix.

Boards so far: Arduino Uno and Nano. ESP32, Mega and Raspberry Pi Pico are planned.

## Install

Shibo is not on the VS Code Marketplace yet. To try it, build the extension package from source:

```
git clone https://github.com/Dagmawi-M/shibo.git
cd shibo
npm install
npm run package
code --install-extension extension/shibo-0.1.0.vsix
```

You also need [arduino-cli](https://arduino.github.io/arduino-cli/latest/installation/) on your PATH with the AVR core:

```
arduino-cli core install arduino:avr
```

Then, in VS Code, click the Shibo icon in the Activity Bar and choose **New Project**.

### Without VS Code

```
npm run app -- path/to/a/sketch/folder
```

and open `http://127.0.0.1:8190`. A Wokwi `diagram.json` in the folder is imported.

## How it is built

| Folder | What is in it |
|---|---|
| `engine/` | The simulator: one virtual clock, the wiring logic, the part models, the Uno emulator backend (avr8js), and a headless command-line runner |
| `app/` | The editor page. It holds no simulation logic; it sends messages to the engine and draws what comes back |
| `server/` | A small local server that serves the page for use without VS Code |
| `extension/` | The VS Code extension that shows the same page in a panel |

The engine owns time: no chip or part advances except when the engine grants it a slice of virtual time. That is what makes runs repeatable.

## Develop

```
npm install
npm test          # needs arduino-cli; some tests compile real sketches
npm run build     # the page and the extension
```

Tests run with Node's built-in runner, and Node 23 or newer is needed because the TypeScript runs directly.

## Limits today

- Its checks are wiring rules, not a full voltage and current calculation.
- Wires take a simple path and cannot be bent by hand.
- The LCD model ignores custom characters and scrolling; NeoPixel strips cannot be chained.

## Credits and licence

Shibo is MIT licensed. It builds on [avr8js](https://github.com/wokwi/avr8js) and [@wokwi/elements](https://github.com/wokwi/wokwi-elements) by Uri Shaked, both MIT. Shibo is an independent project and is not affiliated with Arduino or Wokwi. It contains no Wokwi proprietary code.
