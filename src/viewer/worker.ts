import * as THREE from 'three';

const VESTS = [0xff7a1a, 0xc6f432, 0xff7a1a, 0x1d1d1b];
const SKIN = [0xf1c27d, 0xe0ac69, 0x8d5524, 0xc68642, 0xffdbac];
const PANTS = [0x1f2937, 0x374151, 0x111827, 0x3b4252];

/** What a packer needs to know about the unit it is working on. All positions are in world space. */
export interface PackerPoseCtx {
  /** Sim time (s): smoothing runs on it, so motion keeps up with the playback speed. */
  simT: number;
  /** Centre of the product being picked, on its rack shelf. */
  pick?: THREE.Vector3 | null;
  /** Centre the product ends up at inside the box. */
  place?: THREE.Vector3 | null;
  /** Half extents (x, y, z) of the carried product. */
  carryHalf?: THREE.Vector3 | null;
}

/** A packer at a station: a person ({@link Worker}) or a robot arm (`Robot`). */
export interface Packer {
  readonly root: THREE.Group;
  /** Yaw facing the loop (local +x points at the side track). */
  baseYaw: number;
  /** Pick-cycle phase from which the product travels with the hand / gripper. */
  readonly grabPhase: number;
  /**
   * phase: -1 idle; 0..1 one pick cycle (rack → box, the unit lands in the box at 1); 2 = box finished.
   * `time` is the wall clock (idle motion). Returns the world position of the carried product's centre.
   */
  pose(phase: number, time: number, out: THREE.Vector3, ctx?: PackerPoseCtx): THREE.Vector3;
}

/** Critically damped spring for one value: no overshoot, continuous velocity, stable for any dt. */
export class Spring {
  v = 0;
  constructor(public x = 0) {}
  step(target: number, omega: number, dt: number): number {
    const e = Math.exp(-omega * dt);
    const d = this.x - target;
    const k = (this.v + omega * d) * dt;
    this.x = target + (d + k) * e;
    this.v = (this.v - omega * k) * e;
    return this.x;
  }
  snap(x: number): void {
    this.x = x;
    this.v = 0;
  }
}

/** Seconds of motion to integrate this frame: sim time (follows playback speed), at least wall time. */
export class Clock2 {
  private sim = NaN;
  private wall = NaN;
  dt(simT: number, wallT: number): number {
    const first = Number.isNaN(this.sim);
    const ds = first ? 0 : simT - this.sim;
    const dw = first ? 0 : wallT - this.wall;
    this.sim = simT;
    this.wall = wallT;
    if (first || ds < 0 || dw < 0) return 10; // first frame or restart: settle at once
    return Math.min(10, Math.max(ds, dw));
  }
}

export function smooth(x: number): number {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
}

/** Piecewise keyframe track, eased between keys. Keys are [phase, ...values]. */
export function sampleKeys(keys: number[][], p: number, out: number[]): number[] {
  let i = 0;
  while (i < keys.length - 2 && p > keys[i + 1][0]) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const f = smooth((p - a[0]) / Math.max(1e-6, b[0] - a[0]));
  for (let k = 1; k < a.length; k++) out[k - 1] = a[k] + (b[k] - a[k]) * f;
  return out;
}

// Pick cycle keyframes: phase, turn (share of the turn to the rack), lean, step (share of the step
// towards the rack), right shoulder, right elbow, left shoulder, left elbow. "R" = the reach to the shelf,
// filled in per unit (shoulder angle for the shelf's height).
const R = 100;
const CYCLE: number[][] = [
  [0.0, 0.0, 0.3, 0.0, 0.52, 0.62, 0.45, 0.7], // product just let go in the box
  [0.1, 0.12, 0.12, 0.0, 0.4, 0.9, 0.35, 0.8], // straighten up
  [0.3, 1.0, R, 0.7, R, 0.55, 0.45, 0.6], // turned to the shelf, reaching
  [0.4, 1.0, R, 1.0, R, 0.12, 0.55, 0.45], // grab
  [0.48, 0.92, R, 0.6, R, 0.75, 0.45, 0.6], // pull it off the shelf
  [0.62, 0.45, 0.05, 0.15, 0.42, 1.55, 0.38, 1.25], // carry close to the chest while turning
  [0.76, 0.04, 0.12, 0.0, 0.5, 1.3, 0.45, 1.1], // facing the box
  [0.9, 0.0, 0.32, 0.0, 0.62, 0.8, 0.55, 0.75], // lower it in with both hands
  [1.0, 0.0, 0.3, 0.0, 0.52, 0.62, 0.45, 0.7],
];
const PUSH = [0, 0.3, 0, 1.15, 0.35, 1.1, 0.4];

/** A stylised packer with shoulders, elbows and a turning torso, eased by springs. */
export class Worker implements Packer {
  readonly root = new THREE.Group();
  readonly grabPhase = 0.38;
  private body = new THREE.Group();
  private upper = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private elbowL = new THREE.Group();
  private elbowR = new THREE.Group();
  private hand: THREE.Mesh;
  private head: THREE.Mesh;
  /** Yaw facing the loop. */
  baseYaw = 0;

  private clock = new Clock2();
  // turn (rad), lean, step (m), shoulder R/L, elbow R/L, head yaw
  private s = { turn: new Spring(), lean: new Spring(), step: new Spring(), shR: new Spring(0.1), elR: new Spring(0.3), shL: new Spring(0.1), elL: new Spring(0.3), head: new Spring() };
  private key: number[] = [];
  private keys: number[][] = [];
  private turnTarget = Math.PI * 0.95;
  private reach = 1.1;
  private reachLean = 0.1;
  private tmp = new THREE.Vector3();

  constructor(seed: number) {
    const pick = <T,>(a: T[], k: number) => a[(seed * 7 + k * 13) % a.length];
    const mat = (c: number, r = 0.7) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
    const skin = mat(pick(SKIN, 1), 0.6);
    const pants = mat(pick(PANTS, 2));
    const vest = mat(pick(VESTS, 3), 0.55);
    const shirt = mat(0x2b2f36);
    this.root.add(this.body);
    const legGeo = new THREE.CapsuleGeometry(0.075, 0.72, 4, 10);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, pants);
      leg.position.set(0, 0.47, s * 0.1);
      leg.castShadow = true;
      this.body.add(leg);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.11), mat(0x111111));
      shoe.position.set(0.05, 0.04, s * 0.1);
      this.body.add(shoe);
    }
    this.upper.position.y = 0.92;
    this.body.add(this.upper);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.42, 4, 12), shirt);
    torso.scale.set(0.8, 1, 1.15);
    torso.position.y = 0.33;
    torso.castShadow = true;
    this.upper.add(torso);
    const vestMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.175, 0.34, 4, 12), vest);
    vestMesh.scale.set(0.84, 1, 1.18);
    vestMesh.position.y = 0.36;
    this.upper.add(vestMesh);
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), skin);
    this.head.position.y = 0.78;
    this.head.castShadow = true;
    this.upper.add(this.head);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(pick([0x1d1d1b, 0x2f9e5a, 0x334155], 4)));
    cap.position.y = 0.02;
    this.head.add(cap);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.012, 12, 1, false, -Math.PI / 2, Math.PI), cap.material);
    brim.position.set(0.08, 0.025, 0);
    brim.scale.set(1.2, 1, 1.4);
    this.head.add(brim);
    const upperGeo = new THREE.CapsuleGeometry(0.05, 0.22, 4, 8);
    const foreGeo = new THREE.CapsuleGeometry(0.044, 0.2, 4, 8);
    const handGeo = new THREE.SphereGeometry(0.048, 10, 8);
    let hand: THREE.Mesh | null = null;
    for (const [arm, elbow, s] of [[this.armL, this.elbowL, -1], [this.armR, this.elbowR, 1]] as const) {
      arm.position.set(0, 0.56, s * 0.22);
      const a = new THREE.Mesh(upperGeo, shirt);
      a.position.y = -0.15;
      a.castShadow = true;
      arm.add(a);
      elbow.position.y = -0.3;
      arm.add(elbow);
      const f = new THREE.Mesh(foreGeo, shirt);
      f.position.y = -0.14;
      f.castShadow = true;
      elbow.add(f);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.05, 10), skin);
      cuff.position.y = -0.25;
      elbow.add(cuff);
      const h = new THREE.Mesh(handGeo, skin);
      h.position.y = -0.3;
      h.scale.set(0.9, 1.15, 0.7);
      elbow.add(h);
      if (s > 0) hand = h;
      this.upper.add(arm);
    }
    this.hand = hand!;
  }

  pose(phase: number, time: number, out: THREE.Vector3, ctx?: PackerPoseCtx): THREE.Vector3 {
    const dt = this.clock.dt(ctx?.simT ?? time, time);
    const s = this.s;
    // Aim the turn and the reach at the actual shelf slot.
    if (ctx?.pick && phase >= 0 && phase < 1) {
      this.root.rotation.set(0, this.baseYaw, 0);
      this.root.updateMatrixWorld(true);
      const p = this.root.worldToLocal(this.tmp.copy(ctx.pick));
      let yaw = Math.atan2(-p.z, p.x);
      if (yaw < -0.88 * Math.PI) yaw += 2 * Math.PI;
      this.turnTarget = yaw;
      const h = p.y;
      this.reachLean = Math.min(0.6, Math.max(0, (1.05 - h) * 0.62));
      this.reach = Math.min(1.6, Math.max(0.55, 0.6 + (h - 0.25) * 0.78));
    }
    let turn = 0;
    let lean = 0;
    let step = 0;
    let shR: number;
    let elR: number;
    let shL: number;
    let elL: number;
    let head = 0.25 * Math.sin(time * 0.31) * Math.sin(time * 0.17 + 1);
    let omega = 9;
    if (phase < 0) {
      // Idle: relaxed arms, breathing, weight shifting, looking around.
      const b = Math.sin(time * 1.4);
      turn = 0.08 * Math.sin(time * 0.23);
      lean = 0.03 + 0.015 * b;
      shR = 0.08 + 0.03 * b;
      shL = 0.08 + 0.03 * Math.sin(time * 1.4 + 0.6);
      elR = 0.3 + 0.05 * Math.sin(time * 0.5);
      elL = 0.32 + 0.05 * Math.sin(time * 0.43);
      omega = 5;
    } else if (phase >= 2) {
      [turn, lean, step, shR, elR, shL, elL] = PUSH;
      omega = 6;
    } else {
      // Fill the shelf-dependent placeholders in before interpolating.
      for (let r = 0; r < CYCLE.length; r++) {
        const src = CYCLE[r];
        const dst = (this.keys[r] ??= src.slice());
        dst[2] = src[2] === R ? this.reachLean : src[2];
        dst[4] = src[4] === R ? this.reach : src[4];
      }
      const k = sampleKeys(this.keys, phase, this.key);
      turn = k[0] * this.turnTarget;
      lean = k[1];
      step = k[2] * 0.18;
      shR = k[3];
      elR = k[4];
      shL = k[5];
      elL = k[6];
      head = 0.15 * k[0] * Math.sign(this.turnTarget);
      // Grab is a quick little reach-in.
      if (phase > 0.34 && phase < 0.46) shR += 0.08 * Math.sin(((phase - 0.34) / 0.12) * Math.PI);
    }
    s.turn.step(turn, omega, dt);
    s.lean.step(lean, omega, dt);
    s.step.step(step, omega, dt);
    s.shR.step(shR, omega * 1.2, dt);
    s.elR.step(elR, omega * 1.2, dt);
    s.shL.step(shL, omega, dt);
    s.elL.step(elL, omega, dt);
    s.head.step(head, 4, dt);

    // The feet pivot part of the way, the torso twists the rest.
    const tr = s.turn.x;
    this.root.rotation.set(0, this.baseYaw, 0);
    this.body.rotation.y = tr * 0.4;
    this.body.position.set(Math.cos(tr) * s.step.x, 0, -Math.sin(tr) * s.step.x);
    this.upper.rotation.set(0, tr * 0.6, -s.lean.x);
    this.armR.rotation.set(-0.06, 0, s.shR.x);
    this.armL.rotation.set(0.06, 0, s.shL.x);
    this.elbowR.rotation.z = s.elR.x;
    this.elbowL.rotation.z = s.elL.x;
    this.head.rotation.set(0, s.head.x, s.lean.x * 0.5);
    this.root.updateMatrixWorld(true);
    return this.hand.getWorldPosition(out);
  }
}
