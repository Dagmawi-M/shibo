#!/bin/sh
# A stand-in for arduino-cli in tests. It writes what it was asked to the file
# named by FAKE_LOG, and behaves as FAKE_MODE says:
#   (unset)    everything works; "core install arduino:avr" makes the package folder
#   core-fails "core install" exits 1
#   offline    "core update-index" and "lib update-index" fail the way a missing network does
echo "$*" >> "${FAKE_LOG:-/dev/null}"
case "$1 $2" in
  "config get") echo "${ARDUINO_DIRECTORIES_DATA:-$FAKE_DATA}"; exit 0 ;;
  "core update-index"|"lib update-index")
    [ "$FAKE_MODE" = offline ] && { echo 'Error: Get "https://downloads.arduino.cc/packages/package_index.tar.bz2": dial tcp: lookup downloads.arduino.cc: no such host' >&2; exit 1; }
    echo "Downloading index: package_index.tar.bz2 downloaded"; exit 0 ;;
  "core install")
    [ "$FAKE_MODE" = core-fails ] && { echo "Error during install: something broke" >&2; exit 1; }
    echo "Downloading packages..."; echo "arduino:avr-gcc@7.3.0 34.00 MiB / 34.00 MiB 100.00%"
    d="${ARDUINO_DIRECTORIES_DATA:-$FAKE_DATA}/packages/$(echo "$3" | cut -d: -f1)/hardware/$(echo "$3" | cut -d: -f2)/1.0.0"
    mkdir -p "$d"; echo "Platform $3 installed"; exit 0 ;;
  "lib install") echo "Installed $3"; exit 0 ;;
esac
[ "$1" = "--no-color" ] && [ "$2" = compile ] && { echo "compiled" ; exit 0; }
exit 0
