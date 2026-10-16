import * as THREE from 'three';
import { Loc, ROUTE_NAMES, type Box, type Product, type Simulation } from '../core';
import { buildFactory, cellPoint, BELT_Y, type Factory } from './factory';
import { ProductLayer, productMaterial, type ProductLook } from '../products3d';
import { cardboardTexture, labelTexture } from './textures';
import { Worker } from './worker';

export const BOX_L = 0.56;
export const BOX_W = 0.38;
export const BOX_H = 0.3;

interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

type Remap = (tile: [number, number, number, number, number]) => [number, number, number, number];

/** Everything dynamic in the 3D view, driven by one Simulation. */
export class World {
  readonly root = new THREE.Group();
  readonly factory: Factory;
  private outer: THREE.InstancedMesh;
  private inner: THREE.InstancedMesh;
  private boxCap = 0;
  private boxProducts: ProductLayer;
  private rackProducts: ProductLayer;
  private workers: Worker[] = [];
  private prev = new Map<number, Pose>();
  private cur = new Map<number, Pose>();
  private dockIndex = new Map<number, number>();
  private dockCount = new Map<number, number>();
  private localCache = new Map<number, THREE.Matrix4[]>();
  private looks = new Map<number, ProductLook>();
  private tmpM = new THREE.Matrix4();
  private tmpM2 = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private boxMats: THREE.Material[];
  private innerMats: THREE.Material[];
  private prodMat: THREE.Material;

  constructor(readonly sim: Simulation, atlas: THREE.Texture, private remap: Remap) {
    this.factory = buildFactory(sim);
    this.root.add(this.factory.root);

    const logo = new THREE.MeshStandardMaterial({ map: cardboardTexture(true), roughness: 0.85 });
    const plain = new THREE.MeshStandardMaterial({ map: cardboardTexture(false), roughness: 0.9 });
    const hidden = new THREE.MeshBasicMaterial({ visible: false });
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z. Long sides (±z) carry the logo; top is open.
    this.boxMats = [plain, plain, hidden, plain, logo, logo];
    const innerMat = new THREE.MeshStandardMaterial({ color: 0x9c7448, roughness: 0.95, side: THREE.BackSide });
    this.innerMats = [innerMat, innerMat, hidden, innerMat, innerMat, innerMat];
    this.outer = this.makeBoxMesh(256).outer;
    this.inner = this.makeBoxMesh(256).inner;
    this.root.add(this.outer, this.inner);

    this.prodMat = productMaterial(atlas);
    this.boxProducts = new ProductLayer(this.prodMat, 512);
    this.rackProducts = new ProductLayer(this.prodMat, 256, false);
    this.root.add(this.boxProducts.group, this.rackProducts.group);
    this.fillRacks();

    sim.layout.stations.forEach((g, i) => {
      const w = new Worker(i);
      w.root.position.set(g.worker.x, 0, g.worker.z);
      // Local +x of the worker faces the loop.
      w.baseYaw = Math.atan2(g.normal.z, -g.normal.x);
      this.workers.push(w);
      this.root.add(w.root);
    });
    this.snapshot(true);
  }

  private makeBoxMesh(cap: number) {
    const outer = new THREE.InstancedMesh(new THREE.BoxGeometry(BOX_L, BOX_H, BOX_W).translate(0, BOX_H / 2, 0), this.boxMats, cap);
    const inner = new THREE.InstancedMesh(new THREE.BoxGeometry(BOX_L - 0.02, BOX_H - 0.01, BOX_W - 0.02).translate(0, BOX_H / 2 + 0.01, 0), this.innerMats, cap);
    for (const m of [outer, inner]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = m === outer;
      m.receiveShadow = true;
    }
    this.boxCap = cap;
    return { outer, inner };
  }

  private ensureBoxCap(n: number) {
    if (n <= this.boxCap) return;
    this.root.remove(this.outer, this.inner);
    this.outer.dispose();
    this.inner.dispose();
    const { outer, inner } = this.makeBoxMesh(Math.ceil(n * 1.5));
    this.outer = outer;
    this.inner = inner;
    this.root.add(outer, inner);
  }

  look(p: Product): ProductLook {
    let l = this.looks.get(p.id);
    if (!l) {
      l = {
        shape: p.shape,
        rect: p.tile ? this.remap(p.tile) : [0.001, 0.001, 0.002, 0.002],
        color: new THREE.Color(p.col ?? '#cccccc'),
      };
      this.looks.set(p.id, l);
    }
    return l;
  }

  private fillRacks() {
    const sim = this.sim;
    this.rackProducts.begin();
    sim.slotting.productsAt.forEach((ids, s) => {
      const sv = this.factory.stations[s];
      const q = new THREE.Quaternion().setFromAxisAngle(this.up, sv.rackYaw);
      ids.slice(0, sv.slots.length).forEach((id, k) => {
        const p = sim.catalog.byId.get(id)!;
        const slot = sv.slots[k];
        const w = p.w / 100;
        const h = p.h / 100;
        const d = p.d / 100;
        const k2 = Math.min(1, slot.maxW / w, slot.maxH / h, slot.maxD / d);
        const m = new THREE.Matrix4().compose(slot.pos, q, new THREE.Vector3(Math.max(0.03, w * k2), Math.max(0.03, h * k2), Math.max(0.02, d * k2)));
        this.rackProducts.add(this.look(p), m);
      });
    });
    this.rackProducts.end();
  }

  /** Product transform inside a box (local to the box), stacking in a 3×2 grid. */
  private localFor(box: Box, i: number): THREE.Matrix4 {
    let list = this.localCache.get(box.id);
    if (!list) {
      list = [];
      this.localCache.set(box.id, list);
    }
    while (list.length <= i) {
      const k = list.length;
      const p = this.sim.catalog.byId.get(box.placed[k].productId)!;
      let w = p.w / 100;
      let h = p.h / 100;
      let d = p.d / 100;
      let lie = false;
      if (h > 0.2 && h > w) {
        lie = true;
        [w, h] = [h, w];
      }
      const cellL = (BOX_L - 0.04) / 3;
      const cellW = (BOX_W - 0.04) / 2;
      const s = Math.min(1, (cellL * 0.95) / w, (cellW * 0.95) / d, 0.16 / h);
      const col = k % 3;
      const row = Math.floor(k / 3) % 2;
      const layer = Math.floor(k / 6);
      const x = -BOX_L / 2 + 0.02 + (col + 0.5) * cellL;
      const z = -BOX_W / 2 + 0.02 + (row + 0.5) * cellW;
      const y = 0.012 + Math.min(BOX_H - 0.08, layer * 0.085);
      const q = new THREE.Quaternion();
      if (lie) q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      const jitter = new THREE.Quaternion().setFromAxisAngle(this.up, ((k * 2654435761) % 100) / 100 - 0.5);
      q.premultiply(jitter);
      const scale = lie ? new THREE.Vector3(h * s, w * s, d * s) : new THREE.Vector3(w * s, h * s, d * s);
      const off = lie ? new THREE.Vector3(x + (w * s) / 2, y, z) : new THREE.Vector3(x, y, z);
      list.push(new THREE.Matrix4().compose(off, q, scale.max(new THREE.Vector3(0.02, 0.02, 0.02))));
    }
    return list[i];
  }

  private poseOf(box: Box, queuePos: Map<number, number>): Pose | null {
    const sim = this.sim;
    const L = sim.layout;
    switch (box.loc) {
      case Loc.Pending: {
        const qi = queuePos.get(box.id);
        if (qi === undefined) return null;
        const p = L.inductLane[qi];
        const nx = L.inductLane[0].x - L.inductLane[1].x;
        const nz = L.inductLane[0].z - L.inductLane[1].z;
        return { x: p.x, y: BELT_Y, z: p.z, yaw: Math.atan2(-nz, nx) };
      }
      case Loc.Loop: {
        const p = cellPoint(L, sim.cellOfSlot(box.cell));
        return { x: p.x, y: BELT_Y, z: p.z, yaw: -p.heading };
      }
      case Loc.InLane: {
        const g = L.stations[box.station];
        const p = g.inLane[box.cell];
        return { x: p.x, y: BELT_Y, z: p.z, yaw: Math.atan2(-g.normal.z, g.normal.x) };
      }
      case Loc.OutLane: {
        const g = L.stations[box.station];
        const p = g.outLane[box.cell];
        return { x: p.x, y: BELT_Y, z: p.z, yaw: Math.atan2(g.normal.z, -g.normal.x) };
      }
      case Loc.Dock: {
        const trip = sim.trips.get(box.tripId);
        if (!trip) return null;
        let idx = this.dockIndex.get(box.id);
        if (idx === undefined) {
          idx = this.dockCount.get(trip.id) ?? 0;
          this.dockCount.set(trip.id, idx + 1);
          this.dockIndex.set(box.id, idx);
        }
        const v = this.factory.stackSlot(trip.door, idx);
        return { x: v.x, y: v.y, z: v.z, yaw: 0 };
      }
      default:
        return null;
    }
  }

  /** Call after every sim.step(): records poses for interpolation. */
  snapshot(reset = false): void {
    const sim = this.sim;
    const queuePos = new Map<number, number>();
    const n = Math.min(sim.releaseQueue.length, sim.layout.inductLane.length);
    for (let i = 0; i < n; i++) queuePos.set(sim.releaseQueue[i].id, i);
    const next = new Map<number, Pose>();
    for (const b of sim.boxes.values()) {
      if (b.loc === Loc.Pending && !queuePos.has(b.id)) continue;
      if (b.loc === Loc.Outbound) continue;
      const p = this.poseOf(b, queuePos);
      if (p) next.set(b.id, p);
    }
    if (reset) this.prev = next;
    else {
      this.prev = this.cur;
      for (const [id, p] of next) if (!this.prev.has(id)) this.prev.set(id, p);
    }
    this.cur = next;
    // Forget per-box caches of shipped boxes.
    if (sim.tick % 64 === 0) {
      for (const id of this.localCache.keys()) if (!sim.boxes.has(id)) this.localCache.delete(id);
      for (const id of this.dockIndex.keys()) if (!sim.boxes.has(id)) this.dockIndex.delete(id);
      for (const id of this.dockCount.keys()) if (!sim.trips.has(id)) this.dockCount.delete(id);
    }
  }

  /** Render state at time `T` (between the previous and current tick). */
  update(T: number, alpha: number, wall: number): void {
    const sim = this.sim;
    const boxMatrices: { m: THREE.Matrix4; box: Box }[] = [];
    let n = 0;
    const setBox = (box: Box, x: number, y: number, z: number, yaw: number) => {
      this.tmpQ.setFromAxisAngle(this.up, yaw);
      this.tmpV.set(x, y, z);
      const m = new THREE.Matrix4().compose(this.tmpV, this.tmpQ, this.tmpS.set(1, 1, 1));
      boxMatrices.push({ m, box });
      n++;
    };
    for (const [id, c] of this.cur) {
      const box = sim.boxes.get(id);
      if (!box) continue;
      const p = this.prev.get(id) ?? c;
      let dy = c.yaw - p.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      setBox(box, p.x + (c.x - p.x) * alpha, p.y + (c.y - p.y) * alpha, p.z + (c.z - p.z) * alpha, p.yaw + dy * alpha);
    }
    for (const box of sim.outbound) {
      const trip = sim.trips.get(box.tripId);
      if (!trip) continue;
      const route = this.factory.outboundRoute(trip.door);
      const f = Math.min(1, Math.max(0, (T - box.exitedAt) / sim.cfg.outboundTravel));
      const pt = alongPolyline(route, f);
      setBox(box, pt.x, BELT_Y, pt.z, pt.yaw);
    }
    this.ensureBoxCap(n);
    boxMatrices.forEach(({ m }, i) => {
      this.outer.setMatrixAt(i, m);
      this.inner.setMatrixAt(i, m);
    });
    this.outer.count = this.inner.count = n;
    this.outer.instanceMatrix.needsUpdate = this.inner.instanceMatrix.needsUpdate = true;

    // Products inside boxes (not for boxes already stacked at the dock — they are closed up).
    this.boxProducts.begin();
    for (const { m, box } of boxMatrices) {
      if (box.loc === Loc.Dock) continue;
      for (let i = 0; i < box.placed.length; i++) {
        if (box.placed[i].t > T) break;
        const p = sim.catalog.byId.get(box.placed[i].productId)!;
        this.tmpM.multiplyMatrices(m, this.localFor(box, i));
        this.boxProducts.add(this.look(p), this.tmpM);
      }
    }

    // Workers + carried products + stack lights.
    for (const st of sim.stations) {
      const w = this.workers[st.index];
      const sv = this.factory.stations[st.index];
      let phase = -1;
      let carried: number | null = null;
      let carriedIdx = -1;
      const box = st.packing;
      if (box && T >= st.packStart) {
        const units = box.placed;
        let prevT = st.packStart;
        for (let i = 0; i < units.length; i++) {
          const u = units[i];
          if (u.station !== st.index) continue;
          if (T <= u.t) {
            phase = Math.min(0.999, Math.max(0, (T - prevT) / Math.max(0.2, u.t - prevT)));
            carried = u.productId;
            carriedIdx = i;
            break;
          }
          prevT = u.t;
        }
        if (phase < 0 && T < st.packEnd + 0.8) phase = 2;
      }
      const hand = w.pose(phase, wall + st.index, this.tmpV);
      if (carried !== null && phase > 0.38) {
        const p = sim.catalog.byId.get(carried)!;
        const boxPose = this.cur.get(box!.id);
        const local = this.localFor(box!, carriedIdx);
        this.tmpS.setFromMatrixScale(local);
        if (phase > 0.85 && boxPose) {
          // Lower into the box.
          const f = (phase - 0.85) / 0.15;
          this.tmpQ.setFromAxisAngle(this.up, boxPose.yaw);
          this.tmpM2.compose(new THREE.Vector3(boxPose.x, boxPose.y, boxPose.z), this.tmpQ, new THREE.Vector3(1, 1, 1)).multiply(local);
          const target = new THREE.Vector3().setFromMatrixPosition(this.tmpM2);
          hand.lerp(target, f);
        }
        this.tmpQ.setFromAxisAngle(this.up, w.baseYaw);
        this.tmpM.compose(hand.clone().add(new THREE.Vector3(0, -this.tmpS.y / 2, 0)), this.tmpQ, this.tmpS);
        this.boxProducts.add(this.look(p), this.tmpM);
      }
      const packing = !!box && T < st.packEnd;
      const blocked = !!box && T > st.packEnd + 2;
      sv.light.green.emissiveIntensity = packing ? 2.2 : 0.05;
      sv.light.red.emissiveIntensity = blocked ? 2.2 : 0.05;
      sv.light.yellow.emissiveIntensity = !box ? 1.6 : 0.05;
    }
    this.boxProducts.end();

    this.updateDocks(T);
  }

  private updateDocks(T: number) {
    const sim = this.sim;
    const byDoor: (number | null)[] = this.factory.docks.map(() => null);
    for (const trip of sim.trips.values()) {
      const cur = byDoor[trip.door];
      if (cur === null || trip.id < cur) byDoor[trip.door] = trip.id;
    }
    this.factory.docks.forEach((d, i) => {
      const tid = byDoor[i];
      const trip = tid !== null ? sim.trips.get(tid)! : null;
      const key = trip ? `${trip.id}:${trip.boxesAtDock}:${trip.boxes.length}:${trip.closedAt >= 0}` : 'none';
      if (key !== d.labelKey) {
        d.labelKey = key;
        const lines = trip
          ? [ROUTE_NAMES[trip.route % ROUTE_NAMES.length], `${trip.boxesAtDock}/${trip.boxes.length} boxes${trip.closedAt >= 0 ? '' : ' · open'}`]
          : ['Door ' + (i + 1), 'waiting'];
        const old = d.label.material.map;
        d.label.material.map = labelTexture(lines, { width: 384, band: trip && trip.closedAt >= 0 ? '#22c55e' : '#f59e0b' });
        old?.dispose();
        d.label.material.needsUpdate = true;
      }
      // Truck: drive off when its trip departs, a fresh truck backs in for the next one.
      const st = d.truckState;
      if (trip && st.tripId !== trip.id) {
        if (st.tripId >= 0) st.leavingAt = T;
        st.tripId = trip.id;
      }
      const baseX = sim.layout.docks[i].door.x - 4.3;
      let x = baseX;
      if (st.leavingAt >= 0) {
        const e = T - st.leavingAt;
        if (e < 6) x = baseX - (e < 3 ? (e / 3) ** 2 * 30 : (1 - (e - 3) / 3) ** 2 * 30);
        else st.leavingAt = -1;
      }
      d.truck.position.x = x;
    });
  }

  /** Station whose hit-box the ray hits, or -1. */
  pickStation(ray: THREE.Raycaster): number {
    const hits = ray.intersectObjects(this.factory.stations.map((s) => s.hit), false);
    return hits.length ? (hits[0].object.userData.station as number) : -1;
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}

function alongPolyline(pts: { x: number; z: number }[], f: number): { x: number; z: number; yaw: number } {
  let total = 0;
  const seg: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    seg.push(l);
    total += l;
  }
  let d = f * total;
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i] || i === seg.length - 1) {
      const t = seg[i] > 0 ? Math.min(1, d / seg[i]) : 0;
      const a = pts[i];
      const b = pts[i + 1];
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, yaw: Math.atan2(-(b.z - a.z), b.x - a.x) };
    }
    d -= seg[i];
  }
  const l = pts[pts.length - 1];
  return { x: l.x, z: l.z, yaw: 0 };
}
