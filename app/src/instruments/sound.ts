// Buzzers, heard. The engine works out each buzzer's pitch from how fast its
// pin toggles; this plays that pitch as a square wave, as a piezo would.
const MUTE_KEY = 'shibo.mute';
const VOLUME = 0.05;               // square waves are loud; this sits under speech level

export class Sound {
  private ctx: AudioContext | null = null;
  private voices = new Map<string, { osc: OscillatorNode; gain: GainNode }>();
  private master: GainNode | null = null;
  private want: Record<string, number> = {};
  muted = false;
  onChange: () => void = () => {};

  constructor() {
    try { this.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* not remembered */ }
    // Browsers only let a page make sound after the person has done something on it.
    const wake = () => { if (this.ctx?.state === 'suspended') void this.ctx.resume(); };
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);
  }

  /** Whether anything is sounding (or would be, if not muted). */
  get sounding(): boolean { return Object.values(this.want).some((f) => f > 0); }

  private audio(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  /** Each buzzer's pitch in Hz; 0 or missing is silent. */
  set(tones: Record<string, number>): void {
    this.want = { ...tones };
    for (const [id, v] of this.voices) if (!(tones[id] > 0)) this.stopVoice(id, v);
    for (const [id, f] of Object.entries(tones)) if (f > 0) this.play(id, f);
    this.onChange();
  }

  private play(id: string, freq: number): void {
    const ctx = this.audio();
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    let v = this.voices.get(id);
    if (!v) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'square'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(VOLUME, now + 0.004);   // no click at the start
      osc.connect(gain).connect(this.master); osc.start();
      v = { osc, gain }; this.voices.set(id, v);
    } else v.osc.frequency.setValueAtTime(freq, now);
  }

  private stopVoice(id: string, v: { osc: OscillatorNode; gain: GainNode }): void {
    const ctx = this.ctx!, now = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(now); v.gain.gain.setValueAtTime(v.gain.gain.value, now); v.gain.gain.linearRampToValueAtTime(0, now + 0.004);
    v.osc.stop(now + 0.01);
    this.voices.delete(id);
  }

  stopAll(): void { this.set({}); }

  setMuted(m: boolean): void {
    this.muted = m;
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* not remembered */ }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.01);
    this.onChange();
  }
}
