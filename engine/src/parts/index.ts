import type { PartDef } from '../part.ts';
import { basic } from './basic.ts';
import { inputs } from './inputs.ts';
import { sensors } from './sensors.ts';
import { timing } from './timing.ts';
import { motion } from './motion.ts';
import { displays } from './displays.ts';
import { bus } from './bus.ts';
import { modules } from './modules/index.ts';

/** Every part the engine has a model for, by type. */
export const library: Record<string, PartDef> = Object.fromEntries([...basic, ...inputs, ...sensors, ...timing, ...motion, ...displays, ...bus, ...modules].map((d) => [d.type, d]));
