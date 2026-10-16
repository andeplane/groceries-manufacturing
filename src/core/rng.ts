/** Small, fast, seedable PRNG (mulberry32) plus the distributions the sim needs. */
export class Rng {
  private s: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** Lognormal with the given mean and coefficient of variation. */
  lognormal(mean: number, cv: number): number {
    const sigma2 = Math.log(1 + cv * cv);
    const mu = Math.log(mean) - sigma2 / 2;
    return Math.exp(mu + Math.sqrt(sigma2) * this.normal());
  }

  /** Gaussian with the given mean and standard deviation, truncated below at `min` (resampled). */
  truncNormal(mean: number, sd: number, min: number): number {
    for (let i = 0; i < 16; i++) {
      const x = mean + sd * this.normal();
      if (x >= min) return x;
    }
    return min;
  }

  exponential(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/** Walker alias table: O(1) sampling from a fixed discrete distribution. */
export class AliasTable {
  private prob: Float64Array;
  private alias: Int32Array;
  readonly size: number;

  constructor(weights: ArrayLike<number>) {
    const n = weights.length;
    this.size = n;
    this.prob = new Float64Array(n);
    this.alias = new Int32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += weights[i];
    if (n === 0 || sum <= 0) return;
    const scaled = new Float64Array(n);
    const small: number[] = [];
    const large: number[] = [];
    for (let i = 0; i < n; i++) {
      scaled[i] = (weights[i] * n) / sum;
      (scaled[i] < 1 ? small : large).push(i);
    }
    while (small.length && large.length) {
      const s = small.pop()!;
      const l = large.pop()!;
      this.prob[s] = scaled[s];
      this.alias[s] = l;
      scaled[l] = scaled[l] + scaled[s] - 1;
      (scaled[l] < 1 ? small : large).push(l);
    }
    for (const i of large) this.prob[i] = 1;
    for (const i of small) this.prob[i] = 1;
  }

  sample(rng: Rng): number {
    const i = rng.int(this.size);
    return rng.next() < this.prob[i] ? i : this.alias[i];
  }
}

/** Stable 32-bit hash for strings/ints (used for seed-independent product popularity). */
export function hash32(x: number | string): number {
  let h = 2166136261;
  const s = String(x);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}
