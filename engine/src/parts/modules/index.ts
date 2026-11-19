// Modules and communication parts: shift registers, bus chips, displays,
// storage and serial or radio modules.
import type { PartDef } from '../../part.ts';
import { logic } from './logic.ts';
import { i2cChips } from './i2c.ts';
import { tft } from './tft.ts';
import { sd } from './sd.ts';
import { serialModules } from './serial.ts';
import { rfid } from './rfid.ts';
import { radios } from './nrf24.ts';

export const modules: PartDef[] = [...logic, ...i2cChips, ...tft, ...sd, ...serialModules, ...rfid, ...radios];
