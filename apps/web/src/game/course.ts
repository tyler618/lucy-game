/**
 * The flight surface.
 *
 * One orchestrated moment per hole: the ball leaves the tee, the carry climbs,
 * and nothing else moves. Everything static — sky, treeline, water, fairway,
 * tee marker — is drawn once into its own container and only redrawn on
 * resize. Per frame we touch the ball, its trail, and nothing else, which is
 * what keeps this at 60fps on a mid-tier Android.
 *
 * The client renders; it does not decide. Carry comes from
 * `@ace/core.displayCarryAt` against a server-anchored tee-off time, so the
 * number on screen is the same number the server would settle at.
 */
import { Application, Container, Graphics, Ticker } from 'pixi.js';
import { arcProgress, displayCarryAt, MAX_CARRY } from '@ace/core';

const PALETTE = {
  pine: 0x0e1210,
  green: 0x1a211d,
  green2: 0x232c27,
  fairway: 0x1e2a22,
  card: 0xe9e3d3,
  brass: 0xb08d3f,
  brassLit: 0xd8b566,
  oxblood: 0x7c2d2d,
  oxbloodLit: 0xc25151,
  water: 0x26414c,
  waterLit: 0x35596a,
};

export type CoursePhase = 'idle' | 'flight' | 'landed' | 'drink';

export interface CourseOptions {
  canvas: HTMLCanvasElement;
  reducedMotion: boolean;
}

interface TrailPoint {
  x: number;
  y: number;
}

export class Course {
  private app: Application | null = null;
  private readonly backdrop = new Container();
  private readonly play = new Container();
  private readonly trailGfx = new Graphics();
  private readonly ball = new Graphics();
  private readonly ripple = new Graphics();

  private w = 0;
  private h = 0;
  private teeX = 0;
  private teeY = 0;
  private waterY = 0;

  private phase: CoursePhase = 'idle';
  private teedOffAt: number | null = null;
  private frozenCarry = 1;
  /** The carry the arc is currently scaled to. Grows in steps, never shrinks mid-flight. */
  private horizon = 4;
  private trail: TrailPoint[] = [];
  private rippleAge = 0;

  /** Set by the host each frame so the DOM readout and the canvas agree exactly. */
  onCarry: (carry: number) => void = () => {};

  constructor(private readonly opts: CourseOptions) {}

  async init(): Promise<void> {
    const app = new Application();
    await app.init({
      canvas: this.opts.canvas,
      backgroundAlpha: 0,
      antialias: true,
      // Cap DPR at 2. A 3x phone gains nothing visible here and pays for every
      // pixel of it in fill rate, which is exactly the budget we need for the
      // 60fps floor.
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      powerPreference: 'high-performance',
    });
    this.app = app;
    app.stage.addChild(this.backdrop, this.play);
    this.play.addChild(this.trailGfx, this.ripple, this.ball);
    this.drawBall();
    this.resize();
    app.ticker.add(this.tick);
  }

  resize(): void {
    const app = this.app;
    if (!app) return;
    const parent = this.opts.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    app.renderer.resize(w, h);

    this.teeX = w * 0.13;
    this.teeY = h * 0.86;
    this.waterY = h * 0.9;
    this.drawBackdrop();
  }

  /**
   * Static scene, drawn once per resize.
   *
   * Bands rather than a photographic backdrop: it scales to any aspect without
   * a 200KB image, it stays legible behind a 100px number, and it costs a
   * handful of draw calls instead of a texture upload on a device that has
   * little memory bandwidth to spare.
   */
  private drawBackdrop(): void {
    const g = this.backdrop;
    g.removeChildren();
    const { w, h } = this;

    const sky = new Graphics();
    const bands = 14;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const y = (h * 0.62 * i) / bands;
      sky.rect(0, y, w, h * 0.62 / bands + 1).fill({
        color: mix(0x101a1c, PALETTE.pine, t * 0.85),
        alpha: 1,
      });
    }
    // Brass horizon glow — the one warm thing on screen, so the eye has
    // somewhere to land between holes.
    sky.ellipse(w * 0.72, h * 0.6, w * 0.55, h * 0.14).fill({ color: PALETTE.brass, alpha: 0.1 });
    g.addChild(sky);

    const trees = new Graphics();
    let x = -10;
    let seed = 1337;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    while (x < w + 20) {
      const tw = 14 + rand() * 22;
      const th = h * (0.05 + rand() * 0.07);
      trees.moveTo(x, h * 0.62);
      trees.lineTo(x + tw / 2, h * 0.62 - th);
      trees.lineTo(x + tw, h * 0.62);
      trees.fill({ color: 0x121a15, alpha: 1 });
      x += tw * 0.72;
    }
    g.addChild(trees);

    const ground = new Graphics();
    ground.rect(0, h * 0.62, w, h * 0.38).fill({ color: PALETTE.fairway });
    // Fairway mow stripes, converging toward the pin for depth.
    for (let i = 0; i < 7; i++) {
      const t = i / 7;
      ground
        .moveTo(w * (0.2 + t * 0.9), h * 0.62)
        .lineTo(w * (-0.3 + t * 1.9), h)
        .lineTo(w * (-0.18 + t * 1.9), h)
        .lineTo(w * (0.26 + t * 0.9), h * 0.62)
        .fill({ color: 0x223026, alpha: 0.55 });
    }
    g.addChild(ground);

    const water = new Graphics();
    water.rect(0, this.waterY, w, h - this.waterY).fill({ color: PALETTE.water });
    water.rect(0, this.waterY, w, 2).fill({ color: PALETTE.waterLit, alpha: 0.7 });
    g.addChild(water);

    const tee = new Graphics();
    tee.rect(this.teeX - 16, this.teeY + 4, 32, 3).fill({ color: PALETTE.brass, alpha: 0.55 });
    tee.circle(this.teeX, this.teeY, 2.5).fill({ color: PALETTE.brass });
    g.addChild(tee);
  }

  private drawBall(): void {
    this.ball
      .circle(0, 0, 6)
      .fill({ color: PALETTE.card })
      .circle(-1.6, -1.8, 2.4)
      .fill({ color: 0xffffff, alpha: 0.85 });
    this.ball.position.set(this.teeX, this.teeY);
  }

  /** Tee off. `teedOffAt` is the SERVER's timestamp, already corrected for drift. */
  teeOff(teedOffAt: number): void {
    this.phase = 'flight';
    this.teedOffAt = teedOffAt;
    this.horizon = 4;
    this.trail = [];
    this.rippleAge = 0;
    this.ripple.clear();
  }

  /** Hole over. `won` decides whether the ball rests on the fairway or drowns. */
  settle(carry: number, won: boolean): void {
    this.frozenCarry = carry;
    this.phase = won ? 'landed' : 'drink';
    this.teedOffAt = null;
    if (!won) this.rippleAge = 0.0001;
  }

  reset(): void {
    this.phase = 'idle';
    this.teedOffAt = null;
    this.frozenCarry = 1;
    this.trail = [];
    this.ripple.clear();
    this.trailGfx.clear();
    this.ball.position.set(this.teeX, this.teeY);
    this.ball.scale.set(1);
    this.ball.alpha = 1;
    this.onCarry(1);
  }

  private carryNow(): number {
    if (this.phase === 'flight' && this.teedOffAt !== null) {
      return displayCarryAt(Date.now() - this.teedOffAt);
    }
    return this.frozenCarry;
  }

  private tick = (ticker: Ticker): void => {
    if (!this.app) return;
    const carry = this.carryNow();
    this.onCarry(carry);

    // The arc rescales in steps rather than continuously. A continuously
    // rescaling horizon makes the ball crawl and the whole shot read as slower
    // the better it is going, which is exactly backwards.
    while (carry > this.horizon * 0.82 && this.horizon < MAX_CARRY) {
      this.horizon = Math.min(this.horizon * 2.5, MAX_CARRY);
    }

    const p = arcProgress(carry, this.horizon);
    const { x, y } = this.pointAt(p);

    this.ball.position.set(x, y);

    if (this.phase === 'flight') {
      this.trail.push({ x, y });
      // Bounded trail. Unbounded is a memory leak with a pretty name and it
      // grows the draw cost of every subsequent frame.
      if (this.trail.length > (this.opts.reducedMotion ? 2 : 44)) this.trail.shift();
      this.drawTrail();
    }

    if (this.phase === 'drink') {
      this.animateDrink(ticker.deltaMS);
    }
  };

  /**
   * The shot line.
   *
   * Progress is log-scaled by `arcProgress`, so the crowded low band where
   * almost every hole lands still gets most of the fairway, and a 500x
   * moonshot still fits on a phone screen.
   */
  private pointAt(p: number): { x: number; y: number } {
    const endX = this.w * 0.9;
    const x = this.teeX + (endX - this.teeX) * p;
    if (this.opts.reducedMotion) {
      // Flattened path: still travels, still communicates carry, no arc.
      return { x, y: this.teeY - this.h * 0.42 * p };
    }
    const apex = this.h * 0.56;
    const y = this.teeY - Math.sin(p * Math.PI * 0.82) * apex;
    return { x, y };
  }

  private drawTrail(): void {
    const g = this.trailGfx;
    g.clear();
    if (this.trail.length < 2) return;
    const first = this.trail[0]!;
    g.moveTo(first.x, first.y);
    for (let i = 1; i < this.trail.length; i++) {
      const pt = this.trail[i]!;
      g.lineTo(pt.x, pt.y);
    }
    g.stroke({ color: PALETTE.brass, width: 1.6, alpha: 0.5, cap: 'round', join: 'round' });
  }

  /**
   * The bust beat. It stings for exactly 800ms and then gets out of the way,
   * because the next hole is the product.
   */
  private animateDrink(deltaMs: number): void {
    this.rippleAge += deltaMs;
    const t = Math.min(1, this.rippleAge / 800);
    const x = this.ball.x;

    this.ball.position.y = Math.min(this.waterY + 8, this.ball.y + deltaMs * 0.22);
    this.ball.alpha = 1 - t;
    this.ball.scale.set(1 - t * 0.4);

    if (this.opts.reducedMotion) return;

    const g = this.ripple;
    g.clear();
    for (let i = 0; i < 3; i++) {
      const phase = Math.max(0, t - i * 0.12);
      if (phase <= 0) continue;
      g.ellipse(x, this.waterY + 4, 12 + phase * 90, 3 + phase * 16).stroke({
        color: PALETTE.waterLit,
        width: 1.4,
        alpha: (1 - phase) * 0.7,
      });
    }
  }

  destroy(): void {
    this.app?.ticker.remove(this.tick);
    this.app?.destroy(true, { children: true });
    this.app = null;
  }
}

/** Linear blend of two packed RGB values. */
function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  return (
    ((ar + (br - ar) * t) << 16) | (((ag + (bg - ag) * t) | 0) << 8) | ((ab + (bb - ab) * t) | 0)
  );
}
