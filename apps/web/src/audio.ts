/**
 * Audio.
 *
 * Muted by default and unlocked by a single deliberate gesture. Mobile players
 * play with the sound off, so the game is designed to be fully readable in
 * silence and sound is layered on top as a reward — never as the only carrier
 * of information. Nothing here ever gates gameplay.
 *
 * Tones are synthesised rather than loaded. Four short cues do not justify
 * four network requests and a decode on a device we are already asking to hold
 * 60fps, and this way the audio layer adds nothing to the bundle.
 */
export type Cue = 'tee' | 'mark' | 'drink' | 'tick';

export class Audio {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private enabled = false;

  get on(): boolean {
    return this.enabled;
  }

  /** Must be called from inside a user gesture or the browser will refuse. */
  async toggle(): Promise<boolean> {
    if (!this.enabled) {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return false;
        this.ctx = new Ctor();
        this.gain = this.ctx.createGain();
        this.gain.gain.value = 0.16;
        this.gain.connect(this.ctx.destination);
      }
      await this.ctx.resume();
      this.enabled = true;
    } else {
      this.enabled = false;
      void this.ctx?.suspend();
    }
    return this.enabled;
  }

  play(cue: Cue): void {
    if (!this.enabled || !this.ctx || !this.gain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const spec: Record<Cue, { f: number; to: number; dur: number; type: OscillatorType; vol: number }> = {
      tee: { f: 380, to: 620, dur: 0.09, type: 'triangle', vol: 0.9 },
      mark: { f: 660, to: 990, dur: 0.16, type: 'sine', vol: 1 },
      drink: { f: 300, to: 70, dur: 0.5, type: 'sawtooth', vol: 0.8 },
      tick: { f: 1200, to: 1200, dur: 0.02, type: 'square', vol: 0.25 },
    };
    const s = spec[cue];

    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = s.type;
    osc.frequency.setValueAtTime(s.f, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, s.to), now + s.dur);
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(s.vol, now + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + s.dur);
    osc.connect(env).connect(this.gain);
    osc.start(now);
    osc.stop(now + s.dur + 0.02);
  }
}
