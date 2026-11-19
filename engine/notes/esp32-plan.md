# ESP32 plan (not built)

There is no JavaScript ESP32 emulator, so instead of an in-process backend like
avr8js or rp2040js, Shibo would run Espressif's QEMU fork (`qemu-system-xtensa`
with `-machine esp32`; also `qemu-system-riscv32 -machine esp32c3`) as a child
process and talk to it over a small bridge.

## Pieces
1. **Toolchain.** `esp32:esp32` core 3.x is already installed here (~3.9 GB).
   FQBN `esp32:esp32:esp32`. The build gives `sk.ino.merged.bin` (bootloader,
   partitions, app in one 4 MB flash image), which is what QEMU boots via
   `-drive file=flash.bin,if=mtd,format=raw`.
2. **QEMU.** Espressif ships prebuilt `qemu-xtensa` releases (about 30 MB,
   GPL-2). We download it on first use into `~/.cache/shibo/qemu`, the same way
   arduino-cli fetches cores; it is never bundled with Shibo.
3. **C bridge.** A small QEMU device or plugin (in our fork, GPL) that:
   - reports GPIO output and output-enable changes (from the `GPIO_OUT`/`GPIO_ENABLE`
     registers) as `t_ns pin level` lines;
   - accepts input levels and ADC voltages for pins;
   - pauses the guest at a requested virtual time (`-icount` gives
     deterministic time, so `runUntil(t)` maps to "run until icount reaches t");
   - forwards UART0 as Serial (QEMU's `-serial` on a socket already does this).
   Wire format: line-based text over a Unix socket, so it is easy to debug.
4. **Backend.** `engine/src/backends/esp32.ts` implements `ChipBackend` by
   sending `run <t>` and waiting for the reply with the pin changes, so it has
   the same lockstep shape as the AVR backend. `runUntil` becomes async-in-sync
   (Atomics.wait on a worker), or the session gets an async step: decide when
   building it.
5. **Rewind.** QEMU snapshots (`savevm`/`loadvm` to a qcow2 overlay) are slow
   (hundreds of ms). Start with rewind turned off for ESP32, as for the Pico spike.

## Not covered at first
Wi-Fi and Bluetooth (QEMU has OpenCores Ethernet only), LEDC PWM timing
beyond levels, RMT, touch pins, deep sleep.

## Steps when it is built
1. Script that boots a blink `merged.bin` in stock Espressif QEMU and shows
   UART output (proves the toolchain and image).
2. Add the GPIO bridge to the fork; test a blink with exact timing.
3. Backend plus the `esp32` board entry (DevKit-C pins), a test with a real sketch.
4. Inputs and ADC, then I2C as whole bytes like the AVR TWI.
