// Writing into a project folder. A file there that is really a link to
// somewhere else is never written through: a folder from a stranger must not
// be able to make Shibo overwrite something outside it.
import fs from 'node:fs';
import path from 'node:path';

/** Write a file in a project folder, refusing if the name is a link to another place. */
export function writeInFolder(file: string, data: string): void {
  let link = false;
  try { link = fs.lstatSync(file).isSymbolicLink(); } catch { /* not there yet: an ordinary new file */ }
  if (link) throw new Error(`${path.basename(file)} in this folder is a link to somewhere else, so Shibo did not write to it. Replace it with an ordinary file, then try again.`);
  fs.writeFileSync(file, data);
}
