// What a failed build says to the person: the compiler's error first, and what is missing by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { cleanLog, diagnose } from '../src/builderror.ts';
import { LIBRARIES, BUNDLED } from '../src/libraries.ts';

const E = '\x1b';
const SCRATCH = '/x/cache/uno-abc';
// What arduino-cli really prints for a missing semicolon, as build.ts used to pass it on.
const body = `${SCRATCH}/sk/sk.ino: In function 'void setup()':
${SCRATCH}/sk/sk.ino:1:36: error: expected ';' before '}' token
 void setup() { pinMode(13, OUTPUT) }
                                    ^
Error during build: exit status 1
`;
const RAW = `
${E}[92mUsed platform${E}[0m ${E}[92mVersion${E}[0m ${E}[90mPath${E}[0m
${E}[93marduino:avr${E}[0m   1.8.8   ${E}[90m/home/u/.arduino15/packages/arduino/hardware/avr/1.8.8${E}[0m
${body}
Command failed: arduino-cli compile -b arduino:avr:uno --output-dir ${SCRATCH}/out ${SCRATCH}/sk
${body}`;

test('a compile error starts with the error line, in the person\'s own file, with nothing in the way', () => {
  const out = cleanLog(RAW, SCRATCH, 'blink.ino');
  const lines = out.split('\n');
  assert.equal(lines[0], "blink.ino:1:36: error: expected ';' before '}' token");
  assert.equal(lines[1], ' void setup() { pinMode(13, OUTPUT) }');
  assert.match(lines[2], /^\s+\^$/);
  for (const gone of ['\x1b', 'Used platform', 'Command failed', '/x/cache', '.arduino15', 'exit status']) assert.ok(!out.includes(gone), gone);
  assert.ok(out.includes("blink.ino: In function 'void setup()':"));
  assert.ok(out.indexOf('In function') > out.indexOf('^'), 'the rest follows the error');
  assert.equal(out.match(/expected ';'/g)!.length, 1, 'the log is not repeated');
});

test('other files of the sketch keep their names, and progress lines are dropped', () => {
  const raw = `Downloading index: library_index.tar.bz2 0 B / 4.53 MiB    0.00%\rDownloading index: library_index.tar.bz2 2.49 MiB / 4.53 MiB   54.96%\rDownloading index: library_index.tar.bz2 downloaded\n${SCRATCH}/sk/helper.h:3:1: error: 'foo' does not name a type\n foo bar;\n ^~~\n`;
  const out = cleanLog(raw, SCRATCH, 'blink.ino');
  assert.equal(out.split('\n')[0], "helper.h:3:1: error: 'foo' does not name a type");
  assert.ok(!/Downloading|MiB/.test(out));
});

test('no compiler: the download is offered, with its size', () => {
  const n = diagnose('', { enoent: true })!;
  assert.deepEqual(n.fix, { kind: 'compiler' });
  assert.equal(n.label, 'Download the Arduino compiler (about 80 MB, one time)');
  assert.match(n.message, /Arduino compiler/);
});

test('no board package: installing it is offered; the ATtiny85 one gets a command instead', () => {
  const n = diagnose("Error during build: Platform 'arduino:avr' not found: platform not installed\nTry running `arduino-cli core install arduino:avr`", {})!;
  assert.deepEqual(n.fix, { kind: 'core', pkg: 'arduino:avr' });
  assert.equal(n.label, 'Install the Arduino board package (about 70 MB)');

  const t = diagnose("Error during build: Platform 'ATTinyCore:avr' not found: platform not installed", { cli: '/opt/my tools/arduino-cli' })!;
  assert.equal(t.fix, undefined);
  assert.ok(t.command!.startsWith('"/opt/my tools/arduino-cli" core install ATTinyCore:avr --additional-urls '), t.command);
  assert.match(t.message, /third-party/);
  assert.ok(diagnose("Platform 'ATTinyCore:avr' not found", { cli: 'arduino-cli' })!.command!.startsWith('arduino-cli core install'));
});

test('a missing library is named, and installing it is offered when Shibo knows it', () => {
  const servo = diagnose(`${SCRATCH}/sk/sk.ino:1:10: fatal error: Servo.h: No such file or directory\n #include <Servo.h>\n          ^~~~~~~~~\ncompilation terminated.`, {})!;
  assert.deepEqual(servo.fix, { kind: 'library', name: 'Servo' });
  assert.equal(servo.label, 'Install the Servo library (a small download)');
  assert.match(servo.message, /Servo library/);
  assert.deepEqual(diagnose('x.ino:2:10: fatal error: Adafruit_SSD1306.h: No such file or directory\n #include <Adafruit_SSD1306.h>', {})!.fix, { kind: 'library', name: 'Adafruit SSD1306' });

  const unknown = diagnose('x.ino:1:10: fatal error: Mystery.h: No such file or directory\n #include <Mystery.h>', {})!;
  assert.equal(unknown.fix, undefined);
  assert.match(unknown.message, /Mystery\.h/); assert.match(unknown.message, /library manager/);
});

test('a missing file of the sketch itself is not offered as a library', () => {
  const own = diagnose('x.ino:1:10: fatal error: mine.h: No such file or directory\n #include "mine.h"\n          ^~~~~~~~', {})!;
  assert.equal(own.fix, undefined);
  assert.match(own.message, /mine\.h/); assert.match(own.message, /sketch folder/); assert.ok(!/library manager/.test(own.message));
  const sub = diagnose('x.ino:1:10: fatal error: sub/thing.h: No such file or directory\n #include <sub/thing.h>', {})!;
  assert.equal(sub.fix, undefined);
  // Even a header Shibo knows is the sketch's own when it is asked for in quotes.
  assert.equal(diagnose('x.ino:1:10: fatal error: Servo.h: No such file or directory\n #include "Servo.h"', {})!.fix, undefined);
});

test('a Mac without Rosetta is told the command that installs it', () => {
  const n = diagnose('fork/exec /Users/u/Library/Arduino15/packages/arduino/tools/avr-gcc/7.3.0/bin/avr-g++: bad CPU type in executable', {})!;
  assert.equal(n.command, 'softwareupdate --install-rosetta --agree-to-license');
  assert.match(n.message, /Rosetta/); assert.equal(n.fix, undefined);
});

test('an ordinary compile error needs nothing installed', () => {
  assert.equal(diagnose(RAW, {}), null);
});

test('every library Shibo itself can ask for is one it can name', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const files = ['sketchgen.ts', 'catalog-info.ts', 'catalog-info-more.ts', 'templates.ts'].map((f) => path.join(root, 'engine', 'src', f));
  const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.ino')) files.push(p); } };
  walk(path.join(root, 'examples'));
  const bundled = (h: string) => BUNDLED.some((b) => (b.endsWith('/') ? h.startsWith(b) : h === b));
  const seen = new Set<string>();
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/#include\s*<([^>]+)>/g)) seen.add(m[1]);
  assert.ok(seen.size > 15, 'the scan found the includes');
  const unknown = [...seen].filter((h) => !Object.hasOwn(LIBRARIES, h) && !bundled(h));
  assert.deepEqual(unknown, []);
  assert.equal(LIBRARIES['LiquidCrystal_I2C.h'], 'LiquidCrystal I2C');
});
