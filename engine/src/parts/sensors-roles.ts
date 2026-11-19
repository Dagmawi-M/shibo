// What each sensor module's pins are to a generated starter sketch. Spread into ROLES in sketchgen.ts.
// Buses (I2C, OneWire) and power pins need no pinMode, so those parts are not listed.
type Kind = 'out' | 'in' | 'pullup' | 'analog';
type Role = { pins: string[]; kind: Kind; suffix?: string };
const a = (pin: string): Role[] => [{ pins: [pin], kind: 'analog' }];
const d = (pin: string): Role[] => [{ pins: [pin], kind: 'in' }];
const ad = (ao: string, dout: string): Role[] => [{ pins: [ao], kind: 'analog', suffix: ao }, { pins: [dout], kind: 'in', suffix: dout }];

export const sensorRoles: Record<string, Role[]> = {
  lm35: a('OUT'), tmp36: a('OUT'), 'uv-sensor': a('SIG'), 'rain-sensor': ad('AO', 'DO'), 'soil-moisture': ad('AO', 'DO'),
  'soil-moisture-capacitive': a('AOUT'), 'water-level': a('SIG'), mq135: ad('AOUT', 'DOUT'), 'ir-obstacle': d('OUT'),
  'line-sensor': ad('AO', 'DO'), 'hall-sensor': d('S'), 'hall-analog': a('SIG'), 'hall-module': ad('AO', 'DO'),
  'reed-switch': [{ pins: ['1', '2'], kind: 'pullup' }], 'tilt-ball-switch': [{ pins: ['1', '2'], kind: 'pullup' }],
  'force-sensor': a('SIG'), 'flex-sensor': a('SIG'), 'voltage-sensor': a('S'),
  'vibration-sensor': d('DO'), 'knock-sensor': d('S'), 'piezo-sensor': a('+'), 'touch-sensor': d('SIG'),
  'hc-sr501': d('OUT'), am312: d('OUT'), 'hc-sr505': d('OUT'),
  zmpt101b: a('OUT'), microphone: a('OUT'), 'acs712-5a': a('OUT'), 'acs712-20a': a('OUT'), 'acs712-30a': a('OUT'),
};
