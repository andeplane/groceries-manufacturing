import * as THREE from 'three';

const VESTS = [0xff7a1a, 0xc6f432, 0xff7a1a, 0x1d1d1b];
const SKIN = [0xf1c27d, 0xe0ac69, 0x8d5524, 0xc68642, 0xffdbac];
const PANTS = [0x1f2937, 0x374151, 0x111827, 0x3b4252];

/** A stylised packer. `pose()` drives the turn/reach cycle. */
export class Worker {
  readonly root = new THREE.Group();
  private upper = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private head: THREE.Mesh;
  /** Yaw facing the loop. */
  baseYaw = 0;

  constructor(seed: number) {
    const pick = <T,>(a: T[], k: number) => a[(seed * 7 + k * 13) % a.length];
    const mat = (c: number, r = 0.7) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
    const skin = mat(pick(SKIN, 1), 0.6);
    const pants = mat(pick(PANTS, 2));
    const vest = mat(pick(VESTS, 3), 0.55);
    const shirt = mat(0x2b2f36);
    const legGeo = new THREE.CapsuleGeometry(0.075, 0.72, 4, 10);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, pants);
      leg.position.set(0, 0.47, s * 0.1);
      leg.castShadow = true;
      this.root.add(leg);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.11), mat(0x111111));
      shoe.position.set(0.05, 0.04, s * 0.1);
      this.root.add(shoe);
    }
    this.upper.position.y = 0.92;
    this.root.add(this.upper);
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
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(pick([0x1d1d1b, 0xe9542f, 0x334155], 4)));
    cap.position.y = 0.8;
    this.upper.add(cap);
    for (const [arm, s] of [[this.armL, -1], [this.armR, 1]] as const) {
      arm.position.set(0, 0.56, s * 0.22);
      const a = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.5, 4, 8), shirt);
      a.position.y = -0.3;
      a.castShadow = true;
      arm.add(a);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), skin);
      hand.position.y = -0.6;
      arm.add(hand);
      this.upper.add(arm);
    }
  }

  /**
   * phase: -1 idle; 0..1 one pick cycle (turn to rack, grab, turn back, place); 2 = pushing box out.
   * Returns world position of the right hand (for the carried product).
   */
  pose(phase: number, time: number, out: THREE.Vector3): THREE.Vector3 {
    let turn = 0; // 0 facing loop, 1 facing rack
    let reach = 0; // arm raise (radians)
    if (phase < 0) {
      reach = 0.05 * Math.sin(time * 1.3);
    } else if (phase >= 2) {
      reach = 1.1;
    } else if (phase < 0.3) {
      turn = smooth(phase / 0.3);
      reach = 0.4 * turn;
    } else if (phase < 0.45) {
      turn = 1;
      reach = 0.4 + 0.9 * Math.sin(((phase - 0.3) / 0.15) * Math.PI);
    } else if (phase < 0.75) {
      turn = 1 - smooth((phase - 0.45) / 0.3);
      reach = 0.6;
    } else {
      reach = 0.6 + 0.5 * Math.sin(((phase - 0.75) / 0.25) * Math.PI);
    }
    this.root.rotation.y = this.baseYaw;
    this.upper.rotation.y = turn * Math.PI * 0.95;
    this.armL.rotation.z = reach * 0.9;
    this.armR.rotation.z = reach;
    this.head.rotation.y = 0.2 * Math.sin(time * 0.7);
    this.root.updateMatrixWorld(true);
    const hand = this.armR.children[1] as THREE.Mesh;
    return hand.getWorldPosition(out);
  }
}

function smooth(x: number): number {
  x = Math.min(1, Math.max(0, x));
  return x * x * (3 - 2 * x);
}
