/**
 * Haptics. Three distinct patterns, so the phone tells you what happened
 * before your eyes do.
 *
 *   tee   one short tap  — the ball is away
 *   mark  a double pulse — money banked, and it must feel different from tee
 *   drink one long buzz  — the water, and it should feel bad
 *
 * Silently absent on iOS Safari, which does not expose the Vibration API.
 * Nothing checks the return value because nothing should depend on it.
 */
const PATTERNS = {
  tee: [12],
  mark: [18, 40, 26],
  drink: [140],
} as const;

export type HapticCue = keyof typeof PATTERNS;

let muted = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function setHapticsMuted(value: boolean): void {
  muted = value;
}

export function haptic(cue: HapticCue): void {
  if (muted) return;
  const vibrate = navigator.vibrate?.bind(navigator);
  if (!vibrate) return;
  try {
    vibrate(PATTERNS[cue] as unknown as number[]);
  } catch {
    /* a refused vibration is never worth a log line */
  }
}
