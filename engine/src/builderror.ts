// What a failed build tells the person: the compiler's own error first, in
// their own file's name, and, when something is missing from the computer
// rather than wrong in the sketch, what it is and the one thing that fixes it.
import { LIBRARIES } from './libraries.ts';

/** Something Shibo can install for the person at the press of a button. */
export type Fix = { kind: 'compiler' } | { kind: 'core'; pkg: string } | { kind: 'library'; name: string };

/**
 * Why a build could not be made, when the reason is the setup and not the sketch.
 * `fix` with its button `label` is something Shibo does; `command` is something
 * the person runs themselves.
 */
export interface Need { message: string; fix?: Fix; label?: string; command?: string }

/** Where ATTinyCore's author publishes its package index over HTTPS. */
const ATTINY_INDEX = 'https://raw.githubusercontent.com/SpenceKonde/ReleaseScripts/master/package_drazzy.com_index.json';

export function needCompiler(): Need {
  return { message: 'Shibo needs the Arduino compiler to run a sketch, and it is not on this computer yet.',
    fix: { kind: 'compiler' }, label: 'Download the Arduino compiler (about 80 MB, one time)' };
}

export function needCore(pkg: string, cli = 'arduino-cli'): Need {
  if (pkg === 'arduino:avr') {
    return { message: 'The Arduino board package is not installed yet. The compiler needs it to build for Arduino boards.',
      fix: { kind: 'core', pkg }, label: 'Install the Arduino board package (about 70 MB)' };
  }
  const program = /\s/.test(cli) ? `"${cli}"` : cli;
  if (pkg === 'ATTinyCore:avr') {
    return { message: 'The ATtiny85 board package (ATTinyCore) is not installed. Shibo does not install it for you, because it comes from a third-party server. Run this command to install it, then run the sketch again:',
      command: `${program} core install ATTinyCore:avr --additional-urls ${ATTINY_INDEX}` };
  }
  return { message: `The board package ${pkg} is not installed. Run this command to install it, then run the sketch again:`, command: `${program} core install ${pkg}` };
}

/** What is missing from the computer, read from a failed build's output; null when the sketch itself is at fault. */
export function diagnose(log: string, o: { enoent?: boolean; cli?: string } = {}): Need | null {
  if (o.enoent) return needCompiler();
  if (/bad CPU type in executable/i.test(log)) {
    return { message: 'The Arduino compiler for this Mac is made for Intel processors, so it needs Rosetta. Run this command in Terminal to install Rosetta, then run the sketch again:',
      command: 'softwareupdate --install-rosetta --agree-to-license' };
  }
  const platform = /Platform '([\w.-]+:[\w.-]+)' not found/.exec(log);
  if (platform) return needCore(platform[1], o.cli);
  const missing = /fatal error: ([^\s:]+): No such file or directory\s*\n?([^\n]*)/.exec(log);
  if (missing) {
    const header = missing[1], asked = missing[2] ?? '';
    const own = header.includes('/') || asked.includes(`"${header}"`);
    if (own) return { message: `The sketch includes ${header}, but that file is not in the sketch folder. Add it beside the sketch, or correct the name.` };
    const name = Object.hasOwn(LIBRARIES, header) ? LIBRARIES[header] : undefined;
    if (name) return { message: `This sketch uses the ${name} library, which is not installed yet.`, fix: { kind: 'library', name }, label: `Install the ${name} library (a small download)` };
    return { message: `This sketch needs a library that provides ${header}, and it is not installed. Install it with the Arduino library manager, then run the sketch again.` };
  }
  return null;
}

const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g;
const NOISE = /^(Used (platform|library)\b|Error during build:|compilation terminated\.|Downloading |Installing |Skipping |Configuring |Multiple libraries were found|\s+(Used|Not used): )|\b(downloaded|installed)$|\d (B|KiB|MiB|GiB) \/ /;

/**
 * A failed compile's output, made readable: no colour codes, no progress or
 * version tables, said once, with the scratch copy's path replaced by the
 * sketch's own file name, and the first error (with the line it points at) first.
 */
export function cleanLog(raw: string, scratchDir: string, sketchName: string): string {
  let text = raw.replace(ESCAPES, '');
  const repeat = text.indexOf('\nCommand failed:');                  // Node repeats the whole output after this
  if (repeat >= 0) text = text.slice(0, repeat);
  const sk = scratchDir.replace(/[\\/]+$/, '');
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sep = '[\\\\/]';
  text = text.replace(new RegExp(`${esc(sk)}${sep}sk${sep}sk\\.ino`, 'g'), sketchName)
    .replace(new RegExp(`${esc(sk)}${sep}sk${sep}`, 'g'), '');
  let inTable = false;
  const lines: string[] = [];
  for (const whole of text.split('\n')) {
    const line = whole.slice(whole.lastIndexOf('\r') + 1).trimEnd();   // a progress line overwrites itself
    if (/^Used (platform|library)\b/.test(line)) { inTable = true; continue; }
    if (inTable) { if (/^\S+\s+\S+\s+\S*[\\/]/.test(line)) continue; inTable = false; }
    if (!line.trim() || NOISE.test(line)) continue;
    lines.push(line);
  }
  const first = lines.findIndex((l) => /\berror: /.test(l));
  if (first > 0) {
    // The error line and the source lines under it (they start with a space), ahead of everything else.
    let end = first + 1;
    while (end < lines.length && /^\s/.test(lines[end])) end++;
    lines.unshift(...lines.splice(first, end - first));
  }
  return lines.join('\n');
}
