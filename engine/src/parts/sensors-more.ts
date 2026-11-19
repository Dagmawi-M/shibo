// More sensors: environment, motion, touch, electrical and body. The parts live
// in sensors-*.ts by how they work; this gathers them for the library.
import type { PartDef } from '../part.ts';
import { sensorsAnalog } from './sensors-analog.ts';
import { sensorsI2C } from './sensors-i2c.ts';

export const sensorsMore: PartDef[] = [...sensorsAnalog, ...sensorsI2C];
