# Shibo

**Shibo** (ሽቦ, Amharic for "wire") is a circuit simulator inside VS Code. Place parts, wire them, and run your real Arduino sketch, before you buy anything. It works offline: your sketches and circuits never leave your computer.

## Start in two minutes

1. Click the **Shibo** icon in the Activity Bar (the left edge of VS Code).
2. Click **New Project**, give it a name, and pick a starting circuit: Blink, Button and LED, Night light, or Empty.
3. The simulator opens beside your sketch. Press **Run**.

Already have a sketch? Open its folder and press the **Shibo** button in the status bar, or the board icon at the top right of any `.ino` file. A Wokwi `diagram.json` in the folder is imported.

## What you can do

- **Pick from a catalog:** every part is shown with its picture, grouped and searchable. Drag one onto the canvas, or click it.
- **Build the circuit before any code:** start in an empty folder, wire things up, then press **Create sketch from circuit** to get a starter sketch with a named pin for everything you connected.
- **Wire the easy way:** drag from one pin to another, or click one pin and then the other. The pin under the pointer is named, and the pins you can finish on light up.
- **Change your mind:** right-click a wire or a part to remove it, or select it and press Delete. Undo and redo with Ctrl+Z and Ctrl+Shift+Z.
- **Manage what is in the circuit:** a list of your components sits under the catalog; select or remove any of them there.
- **Upload and run your real sketch:** **Upload & Run** compiles the sketch in the folder and runs it on an emulated ATmega328P. Save the sketch while it is running and it uploads again by itself.
- **Use it like the real thing:** press buttons, turn knobs, flip switches, type into the serial monitor.
- **Set what sensors sense:** each sensor has a slider for light, temperature, gas, sound and so on.
- **See dimming:** LEDs driven with `analogWrite` are drawn at their brightness.
- **Catch mistakes before they cost you:** an LED with no resistor, a button left floating without a pull-up, a relay coil driven straight from a pin, wires to pins that do not exist, two outputs shorted together, a sensor left without power.
- **Start from a template:** an empty canvas offers Blink, Button and LED, Night light, or Empty.
- **Change any part's settings:** click a part to rename it, pick an LED's colour, choose how an LCD is wired, or rotate it (R). Click a wire to recolour it.
- **Move around:** drag the background to pan, **Fit** to see everything, arrow keys to nudge a part.
- **Print a wiring guide:** a page listing what to buy and every connection, with a box to tick as you build.
- **Zoom** in and out for small parts or big circuits.
- **Keep your files yours:** the circuit is saved as `shibo.json` beside the sketch.

## Parts

- **Boards:** Arduino Uno, Arduino Nano.
- **Lights and sound:** LED, RGB LED, LED bar graph, 7-segment display, Buzzer.
- **Basics:** Resistor.
- **Switches and knobs:** Push button, Push button (small), Slide switch, Potentiometer, DIP switch (8), Keypad, Joystick, Slide potentiometer, Rotary encoder.
- **Motors and switching:** Relay, Servo motor, Stepper motor, Two-hand stepper (clock).
- **Sensors:** Light sensor (LDR), Temperature sensor (NTC), Gas sensor, Flame sensor, Sound sensor (large), Sound sensor (small), Motion sensor (PIR), Tilt switch, Heartbeat sensor, Ultrasonic distance (HC-SR04), Temperature and humidity (DHT22), Infrared receiver, Load cell amplifier (HX711), Accelerometer and gyro (MPU6050).
- **Modules:** Infrared remote, Rotary phone dial, Real-time clock (DS1307).
- **Displays:** LCD 16x2, LCD 20x4, OLED display (SSD1306), NeoPixel LED, NeoPixel ring, NeoPixel matrix.

Displays show what your sketch draws: text on the LCDs, pixels on the OLED, colours on NeoPixels. Sensors that work by timing (ultrasonic, DHT22, infrared) answer with the same pulses the real ones send, so the usual libraries and `pulseIn` work.

## Needs

- [arduino-cli](https://arduino.github.io/arduino-cli/latest/installation/) on your PATH, with the AVR core: `arduino-cli core install arduino:avr`.

## Commands

| Command | What it does |
|---|---|
| Shibo: New Project | Creates a folder with a sketch and a wired circuit |
| Shibo: Open Simulator | Opens the simulator for the current folder |
| Shibo: How to Install arduino-cli | Opens the install guide |

## Limits in this version

- Boards: Arduino Uno and Nano. ESP32 and Raspberry Pi Pico are planned.
- Its checks are wiring rules, not yet a full voltage and current calculation: it will not tell you a resistor has the wrong value.

Shibo is an independent project. It is not affiliated with Arduino or Wokwi. Part drawings come from the open-source `@wokwi/elements` library (MIT).

## How it was made

Shibo was designed and directed by its author and built with the help of AI coding assistants (Claude, by Anthropic), which wrote much of the code under the author's review and testing.
