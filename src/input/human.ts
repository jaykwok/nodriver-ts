/** Pure, seeded motion plans. All sampling happens in Node, never in a page or Worker. */
export type Random = () => number;
export function normal(random: Random): number {
  return (
    Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, random()))) * Math.cos(2 * Math.PI * random())
  );
}
export function targetCoordinate(random: Random, inset: number, mean: number): number {
  for (let i = 0; i < 64; i++) {
    const value = mean + normal(random) / 6;
    if (value >= inset && value <= 1 - inset) return value;
  }
  return Math.max(inset, Math.min(1 - inset, mean));
}
export function minimumJerk(t: number): number {
  return t * t * t * (10 + t * (-15 + 6 * t));
}
export function fittsDuration(distance: number, width: number): number {
  return Math.min(1800, 70 + 90 * Math.log2(1 + distance / Math.max(1, width)));
}
export interface MotionPoint {
  x: number;
  y: number;
  delay: number;
}
export function motionPlan(
  from: { x: number; y: number },
  to: { x: number; y: number },
  random: Random,
  options: { width?: number; duration?: number; steps?: number; overshoot?: boolean } = {},
): MotionPoint[] {
  const dx = to.x - from.x,
    dy = to.y - from.y,
    distance = Math.hypot(dx, dy);
  // A pointer already on the target reports no motion, unless a sample count was requested.
  if (distance === 0 && options.steps === undefined) return [];
  const duration = options.duration ?? fittsDuration(distance, options.width ?? 24);
  const steps = options.steps ?? Math.max(2, Math.min(240, Math.ceil(duration * 0.12)));
  const nx = -dy / (distance || 1),
    ny = dx / (distance || 1);
  const bend = Math.min(80, distance * 0.2);
  const b1 = (random() - 0.5) * bend,
    b2 = (random() - 0.5) * bend;
  const extra =
    options.overshoot !== false && distance > 350 && random() < 0.25 ? 4 + random() * 8 : 0;
  const end = {
    x: to.x + (dx / (distance || 1)) * extra,
    y: to.y + (dy / (distance || 1)) * extra,
  };
  const c1 = { x: from.x + dx * 0.28 + nx * b1, y: from.y + dy * 0.28 + ny * b1 };
  const c2 = { x: end.x - dx * 0.18 + nx * b2, y: end.y - dy * 0.18 + ny * b2 };
  const amplitude = 0.5 + random(),
    frequency = 8 + random() * 4,
    phase = random() * Math.PI * 2;
  const result: MotionPoint[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps,
      u = minimumJerk(t),
      v = 1 - u;
    const noise =
      Math.sin(phase + (2 * Math.PI * frequency * duration * t) / 1000) *
      amplitude *
      Math.sin(Math.PI * t) ** 2;
    result.push({
      x:
        v ** 3 * from.x +
        3 * v ** 2 * u * c1.x +
        3 * v * u ** 2 * c2.x +
        u ** 3 * end.x +
        nx * noise,
      y:
        v ** 3 * from.y +
        3 * v ** 2 * u * c1.y +
        3 * v * u ** 2 * c2.y +
        u ** 3 * end.y +
        ny * noise,
      delay: duration / steps,
    });
  }
  if (extra) {
    const pause = 12 + random() * 13;
    const corrections = 3 + Math.floor(random() * 3);
    for (let i = 1; i <= corrections; i++) {
      const u = minimumJerk(i / corrections);
      result.push({
        x: end.x + (to.x - end.x) * u,
        y: end.y + (to.y - end.y) * u,
        delay: 12 + (i === 1 ? pause : 0),
      });
    }
  }
  // A curve bulging past the top or left edge would leave the document (mouseleave).
  if (from.x >= 0 && to.x >= 0) for (const point of result) point.x = Math.max(0, point.x);
  if (from.y >= 0 && to.y >= 0) for (const point of result) point.y = Math.max(0, point.y);
  // Avoid floating point drift at the final hit-tested position.
  Object.assign(result[result.length - 1]!, to);
  return result;
}
const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
function keyPosition(key: string) {
  for (let row = 0; row < rows.length; row++) {
    const col = rows[row]!.indexOf(key.toLowerCase());
    if (col >= 0 && key.length === 1) return { x: col + row * 0.35, y: row, left: col < 5 };
  }
}
export function digraphWeight(previous: string, next: string): number {
  if (previous === next) return 0.65;
  const a = keyPosition(previous),
    b = keyPosition(next);
  if (!a || !b) return 1;
  if (a.left !== b.left) return 0.8;
  return Math.min(1.45, 1 + Math.hypot(a.x - b.x, a.y - b.y) * 0.09);
}
export function keyInterval(
  random: Random,
  range: [number, number],
  previous: string,
  next: string,
): number {
  const [lo, hi] = range;
  if (lo === hi) return lo;
  const median = ((lo + hi) / 2) * digraphWeight(previous, next);
  // Resampling keeps the tails continuous instead of piling clamped values on either bound.
  for (let i = 0; i < 16; i++) {
    const value = median * Math.exp(normal(random) * 0.35);
    if (value >= lo && value <= hi) return value;
  }
  return Math.max(lo, Math.min(hi, median));
}
export function scrollPlan(x: number, y: number, steps: number, profile: 'trackpad' | 'wheel') {
  const weights = Array.from({ length: steps }, (_, i) =>
    profile === 'trackpad' ? (i + 1) * Math.exp((-5 * (i + 1)) / steps) : 1,
  );
  const sum = weights.reduce((a, b) => a + b, 0);
  let sentX = 0,
    sentY = 0;
  return weights.map((w, i) => {
    const deltaX = i === steps - 1 ? x - sentX : (x * w) / sum;
    const deltaY = i === steps - 1 ? y - sentY : (y * w) / sum;
    sentX += deltaX;
    sentY += deltaY;
    return { deltaX, deltaY, delay: profile === 'trackpad' ? 1000 / 120 : 45 };
  });
}
/**
 * Whole wheel notches, each along one axis, with the two axes interleaved evenly. A distance
 * rounds to whole notches.
 */
export function* notchPlan(x: number, y: number, notch: number) {
  const nx = Math.round(Math.abs(x) / notch),
    ny = Math.round(Math.abs(y) / notch),
    total = nx + ny;
  if (!Number.isSafeInteger(total)) throw new RangeError('Too many wheel notches');
  for (let i = 0; i < total; i++) {
    const horizontal = Math.floor(((i + 1) * nx) / total) > Math.floor((i * nx) / total);
    yield {
      deltaX: horizontal ? Math.sign(x) * notch : 0,
      deltaY: horizontal ? 0 : Math.sign(y) * notch,
      delay: 45,
    };
  }
}
