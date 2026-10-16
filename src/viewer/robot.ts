import * as THREE from 'three';
import { Clock2, Spring, type Packer, type PackerPoseCtx } from './worker';

// Arm geometry (metres). The robot stands where a person would, a little towards the belt.
const MOUNT_X = 0.08;
const SHOULDER_Y = 0.86;
const L1 = 0.72; // shoulder → elbow
const L2 = 0.68; // elbow → wrist centre
const TOOL = 0.24; // wrist centre → suction cup lip
const J4_AT = 0.24; // forearm roll joint, from the elbow

const HOME = { yaw: 0, r: 0.48, y: 1.5, pitch: -Math.PI / 2 };
/** Tip height above the box while moving over it (a hanging product clears the box rim). */
const ABOVE_BOX = 1.5;

/** Shared geometries and materials for every robot of one world. */
export class RobotKit {
  readonly paint: THREE.MeshStandardMaterial;
  readonly accent = new THREE.MeshStandardMaterial({ color: 0x2f9e5a, roughness: 0.4, metalness: 0.1 });
  readonly dark = new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.45, metalness: 0.55 });
  readonly steel = new THREE.MeshStandardMaterial({ color: 0xb9c0c8, roughness: 0.28, metalness: 0.9 });
  readonly rubber = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.85 });
  readonly hose = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.6 });
  readonly yellow = new THREE.MeshStandardMaterial({ color: 0xf5c518, roughness: 0.5 });
  readonly black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
  private geos = new Map<string, THREE.BufferGeometry>();

  constructor(color = 0xf2711c) {
    this.paint = new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.15 });
  }

  geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let g = this.geos.get(key);
    if (!g) {
      g = make();
      this.geos.set(key, g);
    }
    return g;
  }
}

/** Cylinder whose axis runs along z (joint housings), or along x. */
function cylZ(r: number, len: number, seg = 28) {
  return new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2);
}
function cylX(r0: number, r1: number, len: number, seg = 24) {
  // r0 at x = 0, r1 at x = len
  return new THREE.CylinderGeometry(r1, r0, len, seg).rotateZ(-Math.PI / 2).translate(len / 2, 0, 0);
}

function easeInOut(x: number): number {
  x = Math.min(1, Math.max(0, x));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

interface Way {
  yaw: number;
  r: number;
  y: number;
  pitch: number;
  /** Tool yaw relative to the robot (only matters when the tool is not pointing straight down). */
  tyaw: number;
}

/**
 * Six-axis industrial robot arm with a suction gripper. Turret yaw, shoulder and elbow come from
 * analytic 2-bone IK in the arm plane; a spherical wrist turns the tool to point down into the box or
 * straight into the rack. Tip motion runs through eased waypoints, and every value is also passed
 * through a critically damped spring so nothing ever snaps.
 */
export class Robot implements Packer {
  readonly root = new THREE.Group();
  readonly grabPhase = 0.45;
  baseYaw = 0;

  private mount = new THREE.Group();
  private turret = new THREE.Group();
  private shoulder = new THREE.Group();
  private elbow = new THREE.Group();
  private j4 = new THREE.Group();
  private a4 = 0;
  private wrist = new THREE.Group();
  private toolRoll = new THREE.Group();
  private led: THREE.MeshStandardMaterial;
  private clock = new Clock2();
  private s = {
    yaw: new Spring(HOME.yaw), r: new Spring(HOME.r), y: new Spring(HOME.y),
    pitch: new Spring(HOME.pitch), tyaw: new Spring(0), roll: new Spring(0),
  };
  private pickL = new THREE.Vector3(-0.9, 1.1, 0);
  private placeL = new THREE.Vector3(0.64, 0.95, 0);
  private half = new THREE.Vector3(0.05, 0.05, 0.05);
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private qc = new THREE.Quaternion();
  private Y = new THREE.Vector3(0, 1, 0);
  private Z = new THREE.Vector3(0, 0, 1);
  private X = new THREE.Vector3(1, 0, 0);

  constructor(seed: number, kit = new RobotKit()) {
    const k = kit;
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(g, m);
      o.position.set(x, y, z);
      o.castShadow = true;
      o.receiveShadow = true;
      parent.add(o);
      return o;
    };
    this.root.add(this.mount);
    this.mount.position.x = MOUNT_X;
    this.mount.rotation.y = ((seed * 37) % 7) * 0.001; // not all identical to the micron

    // --- Floor plate + pedestal (fixed) ---
    mesh(k.geo('plate', () => new THREE.BoxGeometry(0.56, 0.03, 0.56)), k.dark, this.mount, 0, 0.015, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      mesh(k.geo('bolt', () => new THREE.CylinderGeometry(0.018, 0.018, 0.025, 8)), k.steel, this.mount, sx * 0.22, 0.04, sz * 0.22);
    }
    // Yellow safety border painted round the plate edge.
    for (let i = 0; i < 4; i++) {
      const strip = mesh(k.geo('hazard', () => new THREE.BoxGeometry(0.56, 0.006, 0.04)), k.yellow, this.mount, 0, 0.032, 0);
      strip.castShadow = false;
      strip.rotation.y = (i * Math.PI) / 2;
      strip.position.set(i === 1 ? 0.26 : i === 3 ? -0.26 : 0, 0.032, i === 0 ? 0.26 : i === 2 ? -0.26 : 0);
    }
    mesh(k.geo('pedestal', () => new THREE.CylinderGeometry(0.15, 0.17, 0.4, 32)), k.dark, this.mount, 0, 0.23, 0);
    mesh(k.geo('pedflange', () => new THREE.CylinderGeometry(0.2, 0.2, 0.03, 32)), k.dark, this.mount, 0, 0.445, 0);
    // J1 motor housing (fixed part of the base).
    mesh(k.geo('base', () => new THREE.CylinderGeometry(0.19, 0.2, 0.12, 36)), k.paint, this.mount, 0, 0.52, 0);
    mesh(k.geo('basering', () => new THREE.CylinderGeometry(0.195, 0.195, 0.02, 36)), k.accent, this.mount, 0, 0.59, 0);
    // Cable from the floor into the base.
    const cable = mesh(k.geo('basecable', () => new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.32, 0.03, 0.1), new THREE.Vector3(-0.24, 0.05, 0.1), new THREE.Vector3(-0.2, 0.2, 0.06), new THREE.Vector3(-0.16, 0.5, 0.0),
    ]), 16, 0.022, 8)), k.hose, this.mount);
    cable.castShadow = false;

    // --- Turret (J1) ---
    this.turret.position.y = 0.6;
    this.mount.add(this.turret);
    mesh(k.geo('turret', () => new THREE.CylinderGeometry(0.17, 0.19, 0.12, 36)), k.paint, this.turret, 0, 0.06, 0);
    // Shoulder clevis: two cheeks either side of the upper arm hub.
    for (const sz of [-1, 1]) {
      mesh(k.geo('cheek', () => new THREE.BoxGeometry(0.26, 0.26, 0.05).translate(0, 0.13, 0)), k.paint, this.turret, 0.0, 0.1, sz * 0.125);
      mesh(k.geo('cheekcap', () => cylZ(0.115, 0.055)), k.paint, this.turret, 0, SHOULDER_Y - 0.6, sz * 0.125);
      mesh(k.geo('motorcap', () => cylZ(0.085, 0.03)), k.dark, this.turret, 0, SHOULDER_Y - 0.6, sz * 0.165);
    }
    // J1 servo motor standing on the back of the turret.
    mesh(k.geo('j1motor', () => new THREE.CylinderGeometry(0.055, 0.055, 0.16, 20)), k.dark, this.turret, -0.15, 0.2, 0);
    mesh(k.geo('j1motorcap', () => new THREE.CylinderGeometry(0.058, 0.058, 0.03, 20)), k.paint, this.turret, -0.15, 0.29, 0);

    // --- Upper arm (J2) ---
    this.shoulder.position.y = SHOULDER_Y - 0.6;
    this.turret.add(this.shoulder);
    mesh(k.geo('shoulderhub', () => cylZ(0.105, 0.2)), k.paint, this.shoulder);
    mesh(k.geo('upper', () => {
      // Tapered box beam, slightly offset so it reads like a cast link.
      const g = new THREE.BoxGeometry(L1 - 0.1, 0.13, 0.12, 4, 1, 1);
      const pos = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const f = 1 - ((x + (L1 - 0.1) / 2) / (L1 - 0.1)) * 0.28;
        pos.setY(i, pos.getY(i) * f);
        pos.setZ(i, pos.getZ(i) * (0.85 + 0.15 * f));
      }
      g.computeVertexNormals();
      return g.translate(L1 / 2, 0, 0);
    }), k.paint, this.shoulder);
    mesh(k.geo('upperstripe', () => new THREE.BoxGeometry(L1 * 0.5, 0.02, 0.122).translate(L1 * 0.45, 0, 0)), k.accent, this.shoulder, 0, 0.0, 0).castShadow = false;
    mesh(k.geo('upperhose', () => cylX(0.016, 0.016, L1 * 0.8)), k.hose, this.shoulder, L1 * 0.1, 0.075, -0.05);

    // --- Forearm (J3, J4) ---
    this.elbow.position.x = L1;
    this.shoulder.add(this.elbow);
    mesh(k.geo('elbowhub', () => cylZ(0.088, 0.17)), k.paint, this.elbow);
    for (const sz of [-1, 1]) mesh(k.geo('elbowcap', () => cylZ(0.064, 0.02)), k.dark, this.elbow, 0, 0, sz * 0.094);
    mesh(k.geo('j3motor', () => cylX(0.06, 0.06, 0.15)), k.dark, this.elbow, -0.2, 0.0, 0);
    mesh(k.geo('fore0', () => cylX(0.07, 0.06, 0.22)), k.paint, this.elbow, 0.02, 0, 0);
    mesh(k.geo('forehose', () => cylX(0.013, 0.013, 0.2)), k.hose, this.elbow, 0.03, 0.072, 0.0);
    // J4: the outer forearm rolls about its own axis.
    this.j4.position.x = J4_AT;
    this.elbow.add(this.j4);
    mesh(k.geo('j4ring', () => cylX(0.062, 0.062, 0.025)), k.dark, this.j4, 0, 0, 0);
    mesh(k.geo('fore1', () => cylX(0.056, 0.046, L2 - J4_AT - 0.12)), k.paint, this.j4, 0.025, 0, 0);
    // Wrist fork (J5 cheeks).
    for (const sz of [-1, 1]) {
      mesh(k.geo('fork', () => new THREE.BoxGeometry(0.11, 0.08, 0.022).translate(0.055, 0, 0)), k.paint, this.j4, L2 - J4_AT - 0.1, 0, sz * 0.05);
    }

    // --- Wrist (J5 + J6) and tool ---
    this.wrist.position.x = L2 - J4_AT;
    this.j4.add(this.wrist);
    mesh(k.geo('wristhub', () => cylZ(0.042, 0.078)), k.dark, this.wrist);
    this.wrist.add(this.toolRoll);
    mesh(k.geo('j6', () => cylX(0.04, 0.04, 0.05)), k.paint, this.toolRoll, 0.02, 0, 0);
    mesh(k.geo('flange', () => cylX(0.045, 0.045, 0.012)), k.steel, this.toolRoll, 0.07, 0, 0);
    mesh(k.geo('toolbody', () => cylX(0.032, 0.028, 0.08)), k.steel, this.toolRoll, 0.082, 0, 0);
    mesh(k.geo('ejector', () => new THREE.BoxGeometry(0.05, 0.035, 0.03)), k.dark, this.toolRoll, 0.11, 0.045, 0);
    mesh(k.geo('toolhose', () => new THREE.TorusGeometry(0.04, 0.008, 6, 12, Math.PI)), k.hose, this.toolRoll, 0.1, 0.06, 0).rotation.set(0, 0, Math.PI / 2);
    this.led = new THREE.MeshStandardMaterial({ color: 0x0b0d10, emissive: 0x22c55e, emissiveIntensity: 0.0, roughness: 0.3 });
    mesh(k.geo('led', () => new THREE.TorusGeometry(0.031, 0.006, 6, 20).rotateY(Math.PI / 2)), this.led, this.toolRoll, 0.165, 0, 0);
    mesh(k.geo('stem', () => cylX(0.011, 0.011, 0.04)), k.steel, this.toolRoll, 0.165, 0, 0);
    // Bellows suction cup.
    for (let i = 0; i < 2; i++) {
      mesh(k.geo('bellow', () => new THREE.TorusGeometry(0.02, 0.008, 8, 16).rotateY(Math.PI / 2)), k.rubber, this.toolRoll, 0.205 + i * 0.013, 0, 0);
    }
    mesh(k.geo('cup', () => cylX(0.016, 0.034, 0.012)), k.rubber, this.toolRoll, TOOL - 0.012, 0, 0);
  }

  pose(phase: number, time: number, out: THREE.Vector3, ctx?: PackerPoseCtx): THREE.Vector3 {
    const dt = this.clock.dt(ctx?.simT ?? time, time);
    this.root.rotation.set(0, this.baseYaw, 0);
    this.root.updateMatrixWorld(true);
    if (ctx?.pick) this.mount.worldToLocal(this.pickL.copy(ctx.pick));
    if (ctx?.place) this.mount.worldToLocal(this.placeL.copy(ctx.place));
    if (ctx?.carryHalf) this.half.copy(ctx.carryHalf);

    const w = this.target(phase, time);
    const s = this.s;
    const omega = phase < 0 || phase >= 2 ? 6 : 16;
    s.yaw.step(w.yaw, omega, dt);
    s.r.step(w.r, omega, dt);
    s.y.step(w.y, omega, dt);
    s.pitch.step(w.pitch, omega, dt);
    s.tyaw.step(w.tyaw, omega, dt);
    s.roll.step(phase >= 0 && phase < 2 ? 0.6 * Math.sin(phase * Math.PI * 2) : 0, 4, dt);
    const holding = phase >= this.grabPhase && phase < 1;
    this.led.emissiveIntensity = holding ? 2.0 : 0.0;
    return this.solve(s.yaw.x, s.r.x, s.y.x, s.pitch.x, s.tyaw.x, s.roll.x, out);
  }

  /** Where the tip should be at this phase, in mount-local cylindrical coordinates. */
  private target(phase: number, time: number): Way {
    if (phase < 0 || phase >= 2) {
      return {
        yaw: HOME.yaw + 0.06 * Math.sin(time * 0.37),
        r: HOME.r + 0.02 * Math.sin(time * 0.23),
        y: HOME.y + 0.025 * Math.sin(time * 0.61),
        pitch: HOME.pitch,
        tyaw: 0,
      };
    }
    const pl = this.placeL;
    const pk = this.pickL;
    const boxYaw = Math.atan2(-pl.z, pl.x);
    const boxR = Math.hypot(pl.x, pl.z);
    const boxIn: Way = { yaw: boxYaw, r: boxR, y: pl.y + this.half.y + 0.005, pitch: -Math.PI / 2, tyaw: boxYaw };
    const boxUp: Way = { ...boxIn, y: Math.max(ABOVE_BOX, pl.y + 0.55) };
    // Pick from the product's front face, the tool pointing straight into the rack (-x).
    const faceX = pk.x + this.half.z + 0.004;
    const atX = faceX;
    const preX = faceX + 0.16;
    const shelf = (x: number): Way => {
      let yaw = Math.atan2(-pk.z, x);
      if (yaw < -0.85 * Math.PI) yaw += 2 * Math.PI; // dead astern: come round the side away from the stack light
      return { yaw, r: Math.hypot(x, pk.z), y: pk.y, pitch: 0, tyaw: Math.PI };
    };
    const shelfAt = shelf(atX);
    const shelfPre = shelf(preX);
    const seg = (a: Way, b: Way, f: number, transit: boolean): Way => {
      const e = easeInOut(f);
      const lift = transit ? Math.sin(Math.PI * e) : 0;
      return {
        yaw: a.yaw + (b.yaw - a.yaw) * e,
        // Fold in towards the column and lift a little while swinging round.
        r: a.r + (b.r - a.r) * e - lift * Math.max(0, Math.min(a.r, b.r) - 0.36),
        y: a.y + (b.y - a.y) * e + lift * 0.14,
        pitch: a.pitch + (b.pitch - a.pitch) * e,
        tyaw: a.tyaw + (b.tyaw - a.tyaw) * e,
      };
    };
    const span = (p0: number, p1: number) => (phase - p0) / (p1 - p0);
    if (phase < 0.1) return seg(boxIn, boxUp, span(0, 0.1), false);
    if (phase < 0.36) return seg(boxUp, shelfPre, span(0.1, 0.36), true);
    if (phase < 0.43) return seg(shelfPre, shelfAt, span(0.36, 0.43), false);
    if (phase < 0.49) return shelfAt; // vacuum on
    if (phase < 0.56) return seg(shelfAt, shelfPre, span(0.49, 0.56), false);
    if (phase < 0.84) return seg(shelfPre, boxUp, span(0.56, 0.84), true);
    return seg(boxUp, boxIn, span(0.84, 1), false);
  }

  /** IK: tip (yaw, r, y), tool pitch/yaw → joint angles; returns the held product's centre in world. */
  private solve(yaw: number, r: number, y: number, pitch: number, tyaw: number, roll: number, out: THREE.Vector3): THREE.Vector3 {
    const tip = this.tmp.set(r * Math.cos(yaw), y, -r * Math.sin(yaw));
    const cp = Math.cos(pitch);
    const dir = this.dir.set(cp * Math.cos(tyaw), Math.sin(pitch), -cp * Math.sin(tyaw));
    // Wrist centre.
    const wx = tip.x - dir.x * TOOL;
    const wy = tip.y - dir.y * TOOL;
    const wz = tip.z - dir.z * TOOL;
    const j1 = Math.atan2(-wz, wx);
    const wr = Math.max(0.12, Math.hypot(wx, wz));
    const dyw = wy - SHOULDER_Y;
    const d = Math.min(L1 + L2 - 1e-3, Math.max(Math.abs(L1 - L2) + 1e-3, Math.hypot(wr, dyw)));
    const a = Math.atan2(dyw, wr);
    const b = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))));
    const a1 = a + b; // elbow up
    const ex = L1 * Math.cos(a1);
    const ey = L1 * Math.sin(a1);
    const k = d / Math.max(1e-6, Math.hypot(wr, dyw)); // shrink an out-of-reach target onto the reach sphere
    const a2 = Math.atan2(dyw * k - ey, wr * k - ex);
    this.turret.rotation.y = j1;
    this.shoulder.rotation.z = a1;
    this.elbow.rotation.z = a2 - a1;
    // Spherical wrist: tool frame = Ry(tyaw)·Rz(pitch), relative to the forearm Ry(j1)·Rz(a2),
    // split into J4 (roll about the forearm) · J5 (bend) · J6 (roll about the tool).
    this.qa.setFromAxisAngle(this.Y, j1).multiply(this.qb.setFromAxisAngle(this.Z, a2));
    this.qc.setFromAxisAngle(this.Y, tyaw).multiply(this.qb.setFromAxisAngle(this.Z, pitch));
    const rel = this.qa.invert().multiply(this.qc);
    const t = this.tmp2.set(1, 0, 0).applyQuaternion(rel);
    let a4 = Math.atan2(t.z, t.y);
    let b5 = Math.acos(Math.min(1, Math.max(-1, t.x)));
    if (Math.sin(b5) < 0.05) a4 = this.a4; // near the singularity keep J4 where it is
    // Prefer the J4 solution nearer the current one (the other is a4 + π with J5 negated).
    const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
    if (Math.abs(wrap(a4 + Math.PI - this.a4)) < Math.abs(wrap(a4 - this.a4))) {
      a4 += Math.PI;
      b5 = -b5;
    }
    a4 = this.a4 + wrap(a4 - this.a4);
    this.a4 = a4;
    this.j4.quaternion.setFromAxisAngle(this.X, a4);
    this.wrist.quaternion.setFromAxisAngle(this.Z, b5);
    // J6 = what is left once J4·J5 are applied (a roll about the tool axis).
    this.qb.copy(this.j4.quaternion).multiply(this.wrist.quaternion).invert().multiply(rel);
    const a6 = 2 * Math.atan2(this.qb.x, this.qb.w);
    this.toolRoll.quaternion.setFromAxisAngle(this.X, a6 + roll);
    this.root.updateMatrixWorld(true);
    // Held product: its centre sits just beyond the cup along the tool axis.
    const ext = Math.abs(dir.y) * this.half.y + Math.hypot(dir.x, dir.z) * this.half.z;
    this.toolRoll.localToWorld(out.set(TOOL, 0, 0));
    return out.addScaledVector(dir.transformDirection(this.mount.matrixWorld), ext + 0.004);
  }
}
