#!/bin/sh
# A stand-in for arduino-cli in tests. It writes what it was asked to the file
# named by FAKE_LOG, and behaves as FAKE_MODE says:
#   (unset)    everything works; "core install arduino:avr" makes the package folder
#   core-fails "core install" exits 1
#   offline    "core update-index" and "lib update-index" fail the way a missing network does
#   needs-servo  compiling fails for want of the Servo library until "lib install Servo" has run
#   no-config  it cannot say where its data folder is (as an old arduino-cli cannot)
#   rosetta    compiling fails the way an Intel-only compiler does on a Mac without Rosetta
# A compile that works copies the firmware named by FAKE_HEX to the output folder.
echo "$*" >> "${FAKE_LOG:-/dev/null}"
case "$1 $2" in
  "config get") [ "$FAKE_MODE" = no-config ] && exit 1; echo "${ARDUINO_DIRECTORIES_DATA:-$FAKE_DATA}"; exit 0 ;;
  "core update-index"|"lib update-index")
    [ "$FAKE_MODE" = offline ] && { echo 'Error: Get "https://downloads.arduino.cc/packages/package_index.tar.bz2": dial tcp: lookup downloads.arduino.cc: no such host' >&2; exit 1; }
    echo "Downloading index: package_index.tar.bz2 downloaded"; exit 0 ;;
  "core install")
    [ "$FAKE_MODE" = core-fails ] && { echo "Error during install: something broke" >&2; exit 1; }
    echo "Downloading packages..."; echo "arduino:avr-gcc@7.3.0 34.00 MiB / 34.00 MiB 100.00%"
    d="${ARDUINO_DIRECTORIES_DATA:-$FAKE_DATA}/packages/$(echo "$3" | cut -d: -f1)/hardware/$(echo "$3" | cut -d: -f2)/1.0.0"
    mkdir -p "$d"; echo "Platform $3 installed"
    # like the real one, it leaves the archives it downloaded behind
    [ -n "$ARDUINO_DIRECTORIES_DOWNLOADS" ] && mkdir -p "$ARDUINO_DIRECTORIES_DOWNLOADS/packages" && echo archive > "$ARDUINO_DIRECTORIES_DOWNLOADS/packages/avr-gcc.tar.bz2"
    exit 0 ;;
  "lib install") [ -n "$FAKE_STATE" ] && : > "$FAKE_STATE/lib-$3"; echo "Installed $3"; exit 0 ;;
esac
if [ "$1" = "--no-color" ] && [ "$2" = compile ]; then
  [ "$FAKE_MODE" = rosetta ] && { echo "fork/exec /Users/u/Library/Arduino15/packages/arduino/tools/avr-gcc/bin/avr-g++: bad CPU type in executable" >&2; exit 1; }
  if [ "$FAKE_MODE" = needs-servo ] && [ ! -f "$FAKE_STATE/lib-Servo" ]; then
    echo "/x/sk/sk.ino:1:10: fatal error: Servo.h: No such file or directory" >&2; echo " #include <Servo.h>" >&2; exit 1
  fi
  out=""; while [ $# -gt 0 ]; do [ "$1" = "--output-dir" ] && out="$2"; shift; done
  mkdir -p "$out" && cp "$FAKE_HEX" "$out/sk.ino.hex"; echo "Sketch uses 924 bytes"; exit 0
fi
exit 0
