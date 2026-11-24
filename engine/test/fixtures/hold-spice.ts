// Starts the circuit solver as Shibo does, says its process id, then either
// leaves at once ("exit") or stays until it is killed ("stay"). Used to check
// that the solver does not outlive the program that started it.
import { Spice } from '../../src/electrical/spice.ts';
const s = new Spice();
await s.op(['* t', 'V1 a 0 5', 'R1 a 0 1k']);
console.log(`pid ${(s as unknown as { proc: { pid: number } }).proc.pid}`);
if (process.argv[2] === 'exit') process.exit(0);
setInterval(() => {}, 1000);
