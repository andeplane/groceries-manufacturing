import * as THREE from 'three';
import { loopCellPoint, type Layout, type P2, type Simulation, type StationGeom, type Zone } from '../core';
import { floorTexture, labelTexture, truckTexture } from './textures';

export const BELT_Y = 0.8;
export const LOOP_WIDTH = 0.52;
export const LANE_WIDTH = 0.5;

export const ZONE_COLOR: Record<Zone, string> = {
  ambient: '#e9c46a',
  chilled: '#4ea8de',
  frozen: '#a8dadc',
};

const BLUE = new THREE.MeshStandardMaterial({ color: 0x1f3fa8, roughness: 0.35, metalness: 0.5 });
const STEEL = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.85 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7, metalness: 0.4 });
/** Flat floor markings: pulled towards the camera in depth so they never fight with the floor. */
const DECAL = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 } as const;
const YELLOW = new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.45, metalness: 0.3 });

interface PathOptions {
  closed?: boolean;
  y?: number;
  /** Drop rail pieces whose centre fails this test (where belts join). */
  keepRail?: (p: P2) => boolean;
  /** Drop rollers whose centre fails this test. */
  keepRoller?: (p: P2) => boolean;
}

/** Collects conveyor parts as instances and builds a handful of InstancedMeshes. */
class ConveyorBuilder {
  rails: THREE.Matrix4[] = [];
  rollers: THREE.Matrix4[] = [];
  beds: THREE.Matrix4[] = [];
  legs: THREE.Matrix4[] = [];
  private legAcc = 0;

  addPath(pts: P2[], width: number, opts: PathOptions = {}) {
    const { closed = false, y = BELT_Y, keepRail, keepRoller } = opts;
    const n = closed ? pts.length : pts.length - 1;
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const step = 0.11;
    // Rollers are spaced by distance along the whole path, so tight curves made of short segments stay even.
    let rollerAcc = step / 2;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      const yaw = Math.atan2(-dz, dx);
      q.setFromAxisAngle(up, yaw);
      const nx = -dz / len;
      const nz = dx / len;
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      for (const s of [-1, 1]) {
        const rx = mx + nx * s * (width / 2 + 0.03);
        const rz = mz + nz * s * (width / 2 + 0.03);
        if (keepRail && !keepRail({ x: rx, z: rz })) continue;
        this.rails.push(new THREE.Matrix4().compose(new THREE.Vector3(rx, y + 0.05, rz), q, new THREE.Vector3(len + 0.012, 0.09, 0.05)));
      }
      this.beds.push(new THREE.Matrix4().compose(new THREE.Vector3(mx, y - 0.1, mz), q, new THREE.Vector3(len + 0.012, 0.1, width + 0.06)));
      const rq = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, yaw, 0, 'YXZ'));
      while (rollerAcc <= len) {
        const f = rollerAcc / len;
        const p = { x: a.x + dx * f, z: a.z + dz * f };
        if (!keepRoller || keepRoller(p)) {
          this.rollers.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x, y - 0.03, p.z), rq, new THREE.Vector3(1, width, 1)));
        }
        rollerAcc += step;
      }
      rollerAcc -= len;
      this.legAcc += len;
      if (this.legAcc > 1.6) {
        this.legAcc = 0;
        for (const s of [-1, 1]) {
          this.legs.push(
            new THREE.Matrix4().compose(
              new THREE.Vector3(mx + nx * s * (width / 2), (y - 0.15) / 2, mz + nz * s * (width / 2)),
              q,
              new THREE.Vector3(0.05, y - 0.15, 0.05),
            ),
          );
        }
      }
    }
  }

  build(): THREE.Group {
    const g = new THREE.Group();
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], shadow = true) => {
      const m = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((x, i) => m.setMatrixAt(i, x));
      m.castShadow = shadow;
      m.receiveShadow = true;
      g.add(m);
    };
    mk(new THREE.BoxGeometry(1, 1, 1), BLUE, this.rails);
    mk(new THREE.BoxGeometry(1, 1, 1), DARK, this.beds);
    mk(new THREE.CylinderGeometry(0.024, 0.024, 1, 10), STEEL, this.rollers, false);
    mk(new THREE.BoxGeometry(1, 1, 1), STEEL, this.legs);
    return g;
  }
}

export interface StationVisual {
  light: { red: THREE.MeshStandardMaterial; yellow: THREE.MeshStandardMaterial; green: THREE.MeshStandardMaterial };
  hit: THREE.Mesh;
  /** Rack shelf slots for products: world positions + max sizes. */
  slots: { pos: THREE.Vector3; maxW: number; maxH: number; maxD: number }[];
  rackYaw: number;
}

export interface DockVisual {
  door: P2;
  laneZ: number;
  truck: THREE.Group;
  label: THREE.Sprite;
  labelKey: string;
  truckState: { tripId: number; leavingAt: number; arrivingAt: number };
}

export interface Factory {
  root: THREE.Group;
  stations: StationVisual[];
  docks: DockVisual[];
  /** Polyline from the loop exit to a door's stacking area. */
  outboundRoute: (door: number) => P2[];
  stackSlot: (door: number, i: number) => THREE.Vector3;
}

function sprite(tex: THREE.Texture, w: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  const img = tex.image as HTMLCanvasElement;
  s.scale.set(w, (w * img.height) / img.width, 1);
  return s;
}

export function buildFactory(sim: Simulation): Factory {
  const layout: Layout = sim.layout;
  const root = new THREE.Group();
  const b = layout.bounds;
  const W = b.maxX - b.minX + 30;
  const D = b.maxZ - b.minZ + 30;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;

  // Floor: the hall ends at the dock wall; outside it the apron takes over (no overlapping planes).
  const hallMinX = layout.docks[0].door.x;
  const hallMaxX = cx + W / 2;
  const hallW = hallMaxX - hallMinX;
  const ft = floorTexture();
  ft.repeat.set(hallW / 6, D / 6);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(hallW, D), new THREE.MeshStandardMaterial({ map: ft, roughness: 0.62, metalness: 0.05 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((hallMinX + hallMaxX) / 2, 0, cz);
  floor.receiveShadow = true;
  root.add(floor);

  // Yellow walkway lines around the loop
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xf2c200, ...DECAL });
  const addLine = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.1), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.atan2(z1 - z0, x1 - x0) * -1;
    m.position.set((x0 + x1) / 2, 0.003, (z0 + z1) / 2);
    root.add(m);
  };
  const ox = layout.straight / 2 + layout.radius + 1.2;
  const oz = b.maxZ - 0.8;
  addLine(-ox, oz, ox, oz);
  addLine(-ox, -oz, ox, -oz);
  addLine(ox, -oz, ox, oz);

  // Conveyors. Side tracks first: the loop's outer rail opens wherever a side track joins it.
  const cb = new ConveyorBuilder();
  const branches = layout.stations.map((g) => sideTrackPath(layout, g));
  const induct = inductPath(layout);
  branches.push(induct.bend);
  const onBranch = (p: P2) =>
    branches.some((pts) => pts.some((c, i) => i > 0 && distToSegment(p, pts[i - 1], c) < LANE_WIDTH / 2 + 0.02));
  const loopPts: P2[] = [];
  const nLoop = Math.round(layout.perimeter / 0.25);
  for (let i = 0; i < nLoop; i++) {
    const s = (i / nLoop) * layout.cells;
    loopPts.push(cellPoint(layout, s));
  }
  cb.addPath(loopPts, LOOP_WIDTH, { closed: true, keepRail: (p) => !onBranch(p) });
  layout.stations.forEach((g, i) => {
    const a = cellPoint(layout, g.divertCell);
    // How far a point is from the loop's centreline, sideways (stations sit on the straights).
    const lateral = (p: P2) => (p.x - a.x) * g.normal.x + (p.z - a.z) * g.normal.z;
    cb.addPath(branches[i], LANE_WIDTH, {
      // Sits a touch lower so the loop's belt stays on top where they overlap.
      y: BELT_Y - 0.008,
      keepRail: (p) => lateral(p) > LOOP_WIDTH / 2 + 0.05,
      keepRoller: (p) => lateral(p) > LOOP_WIDTH / 2 + 0.06,
    });
  });

  const stations: StationVisual[] = [];
  const rackParts: THREE.Matrix4[] = [];
  const shelfParts: THREE.Matrix4[] = [];
  const zoneTiles: { p: P2; yaw: number; zone: Zone; len: number; depth: number }[] = [];
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  for (const g of layout.stations) {
    const n = g.normal;
    const t = g.tangent;
    // Rack behind the worker, facing the loop.
    const rack = g.rack;
    const rackYaw = Math.atan2(-g.tangent.z, g.tangent.x);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rackYaw);
    const rw = 2.1;
    const rd = 0.5;
    const rh = 1.9;
    for (const s of [-1, 1]) {
      for (const dd of [-1, 1]) {
        rackParts.push(
          new THREE.Matrix4().compose(
            new THREE.Vector3(rack.x + t.x * s * (rw / 2) + n.x * dd * (rd / 2), rh / 2, rack.z + t.z * s * (rw / 2) + n.z * dd * (rd / 2)),
            q,
            new THREE.Vector3(0.05, rh, 0.05),
          ),
        );
      }
    }
    const shelfYs = [0.25, 0.65, 1.05, 1.45, 1.82];
    const slots: StationVisual['slots'] = [];
    for (const y of shelfYs) {
      shelfParts.push(new THREE.Matrix4().compose(new THREE.Vector3(rack.x, y, rack.z), q, new THREE.Vector3(rw, 0.03, rd)));
    }
    const perShelf = 12;
    for (let si = 0; si < 4; si++) {
      // Most popular products on the middle shelves (index 1, 2 first).
      const shelf = [1, 2, 0, 3][si];
      const y = shelfYs[shelf] + 0.016;
      for (let k = 0; k < perShelf; k++) {
        const off = -rw / 2 + (k + 0.5) * (rw / perShelf);
        slots.push({
          pos: new THREE.Vector3(rack.x + t.x * off - n.x * 0.05, y, rack.z + t.z * off - n.z * 0.05),
          maxW: (rw / perShelf) * 0.86,
          maxH: 0.34,
          maxD: rd * 0.8,
        });
      }
    }

    // Stack light: green packing, yellow waiting for boxes, red blocked.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.7), STEEL);
    const pk = g.inLane[g.inLane.length - 1];
    const lx = pk.x + t.x * 0.75 + n.x * 0.35;
    const lz = pk.z + t.z * 0.75 + n.z * 0.35;
    pole.position.set(lx, BELT_Y + 0.35, lz);
    root.add(pole);
    const mkLight = (color: number, i: number) => {
      const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.05, roughness: 0.3 });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.08, 16), m);
      mesh.position.set(lx, BELT_Y + 0.75 + i * 0.085, lz);
      root.add(mesh);
      return m;
    };
    const light = { green: mkLight(0x22c55e, 0), yellow: mkLight(0xfacc15, 1), red: mkLight(0xef4444, 2) };

    const zone = sim.stations[g.index].zone;
    const label = sprite(labelTexture([`${g.index + 1}`], { band: ZONE_COLOR[zone], width: 128 }), 0.55);
    label.position.set(rack.x, 2.35, rack.z);
    root.add(label);

    // Footprint of the whole station (side track, worker, rack) for clicks and the zone tint.
    const along0 = cellPoint(layout, g.divertCell);
    const along1 = cellPoint(layout, g.mergeCell);
    const len = Math.hypot(along1.x - along0.x, along1.z - along0.z) + 0.4;
    const depth = layout.sideOffset + 2.0;
    const centre = {
      x: (along0.x + along1.x) / 2 + n.x * (depth / 2 + 0.2),
      z: (along0.z + along1.z) / 2 + n.z * (depth / 2 + 0.2),
    };
    const hit = new THREE.Mesh(new THREE.BoxGeometry(len, 2.2, depth), hitMat);
    hit.position.set(centre.x, 1.1, centre.z);
    hit.rotation.y = rackYaw;
    hit.userData.station = g.index;
    root.add(hit);

    zoneTiles.push({ p: centre, yaw: rackYaw, zone, len, depth });
    stations.push({ light, hit, slots, rackYaw });
  }
  const rackMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), BLUE, rackParts.length);
  rackParts.forEach((m, i) => rackMesh.setMatrixAt(i, m));
  rackMesh.castShadow = true;
  root.add(rackMesh);
  const shelfMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.5, metalness: 0.6 }), shelfParts.length);
  shelfParts.forEach((m, i) => shelfMesh.setMatrixAt(i, m));
  shelfMesh.castShadow = true;
  shelfMesh.receiveShadow = true;
  root.add(shelfMesh);

  // Zone floor tint (chilled/frozen areas are colder: tinted floor + strip curtain feel).
  for (const z of zoneTiles) {
    if (z.zone === 'ambient') continue;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(z.len, z.depth),
      new THREE.MeshStandardMaterial({ color: ZONE_COLOR[z.zone], transparent: true, opacity: 0.28, roughness: 0.4, depthWrite: false, ...DECAL }),
    );
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = z.yaw;
    m.position.set(z.p.x, 0.004, z.p.z);
    root.add(m);
  }

  // Induction: box erector + incoming lane, curving onto the loop.
  const il = layout.inductLane;
  const onLoop = (p: P2) => loopPts.some((c, i) => i > 0 && distToSegment(p, loopPts[i - 1], c) < LOOP_WIDTH / 2 + 0.05);
  cb.addPath([{ x: il[il.length - 1].x, z: il[il.length - 1].z + 0.4 }, ...induct.bend], LANE_WIDTH, {
    y: BELT_Y - 0.008,
    keepRail: (p) => !onLoop(p),
    keepRoller: (p) => !onLoop(p),
  });
  const erector = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.9, 1.3), new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.4, metalness: 0.3 }));
  body.position.y = 0.95;
  body.castShadow = true;
  erector.add(body);
  const win = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.8), new THREE.MeshStandardMaterial({ color: 0x223, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.6 }));
  win.position.set(0, 1.25, 0.66);
  erector.add(win);
  // The opening the folded boxes come out of, onto the lane.
  const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.42), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9 }));
  mouth.rotation.y = Math.PI;
  mouth.position.set(0, BELT_Y + 0.2, -0.656);
  erector.add(mouth);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.05, 0.06), YELLOW);
  lip.position.set(0, BELT_Y + 0.43, -0.67);
  erector.add(lip);
  const tag = sprite(labelTexture(['Box erector'], { width: 320 }), 1.1);
  tag.position.set(0, 2.25, 0);
  erector.add(tag);
  const last = il[il.length - 1];
  erector.position.set(last.x, 0, last.z + 1.3);
  root.add(erector);
  const flat = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 1.0), new THREE.MeshStandardMaterial({ color: 0xb48a5a, roughness: 0.9 }));
  flat.position.set(last.x - 1.6, 0.3, last.z + 1.4);
  flat.castShadow = true;
  root.add(flat);

  // Outbound conveyor to the dock.
  const docks: DockVisual[] = [];
  const ob = layout.outboundPath;
  const spineX = ob[ob.length - 1].x;
  const doorZs = layout.docks.map((d) => d.door.z);
  const dockWallX = layout.docks[0].door.x;
  const laneOffset = 1.55;
  const laneZs = doorZs.map((z) => z + laneOffset);
  const zMin = Math.min(ob[ob.length - 1].z, ...laneZs);
  const zMax = Math.max(ob[ob.length - 1].z, ...laneZs);
  cb.addPath(ob, LANE_WIDTH);
  cb.addPath([{ x: spineX, z: zMax + 0.3 }, { x: spineX, z: zMin - 0.3 }], LANE_WIDTH);
  const laneEndX = dockWallX + 4.2;
  for (const z of laneZs) cb.addPath([{ x: spineX - 0.3, z }, { x: laneEndX, z }], LANE_WIDTH);
  root.add(cb.build());

  // Dock wall with doors and trucks.
  const wallH = 6;
  const doorW = 3.0;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd8dadf, roughness: 0.85 });
  const zs = [...doorZs].sort((p, q) => p - q);
  const wallStart = b.minZ - 8;
  const wallEnd = b.maxZ + 8;
  let zc = wallStart;
  for (const dz of zs) {
    const z0 = dz - doorW / 2;
    if (z0 > zc) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.3, wallH, z0 - zc), wallMat);
      seg.position.set(dockWallX - 0.15, wallH / 2, (zc + z0) / 2);
      seg.receiveShadow = true;
      root.add(seg);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.3, wallH - 3.4, doorW), wallMat);
    lintel.position.set(dockWallX - 0.15, 3.4 + (wallH - 3.4) / 2, dz);
    root.add(lintel);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, doorW + 0.1), YELLOW);
    frame.position.set(dockWallX - 0.1, 3.4, dz);
    root.add(frame);
    zc = dz + doorW / 2;
  }
  const segEnd = new THREE.Mesh(new THREE.BoxGeometry(0.3, wallH, wallEnd - zc), wallMat);
  segEnd.position.set(dockWallX - 0.15, wallH / 2, (zc + wallEnd) / 2);
  root.add(segEnd);
  // Back walls (north and east) for a sense of enclosure.
  const north = new THREE.Mesh(new THREE.BoxGeometry(b.maxX - dockWallX + 8, wallH, 0.3), wallMat);
  north.position.set((b.maxX + 8 + dockWallX) / 2, wallH / 2, wallStart);
  north.receiveShadow = true;
  root.add(north);
  const east = new THREE.Mesh(new THREE.BoxGeometry(0.3, wallH, wallEnd - wallStart), wallMat);
  east.position.set(b.maxX + 8, wallH / 2, (wallStart + wallEnd) / 2);
  east.receiveShadow = true;
  root.add(east);

  // Outside apron
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(26, wallEnd - wallStart + 20), new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.95 }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(dockWallX - 13, -0.02, (wallStart + wallEnd) / 2);
  apron.receiveShadow = true;
  root.add(apron);

  const tt = truckTexture();
  layout.docks.forEach((d, i) => {
    const truck = makeTruck(tt);
    truck.position.set(dockWallX - 4.3, 0, d.door.z);
    root.add(truck);
    const label = sprite(labelTexture(['—'], { width: 384 }), 2.2);
    label.position.set(dockWallX + 0.6, 4.3, d.door.z);
    root.add(label);
    docks.push({ door: d.door, laneZ: laneZs[i], truck, label, labelKey: '', truckState: { tripId: -1, leavingAt: -1, arrivingAt: -1 } });
  });

  // Steel columns along the back wall (yellow, like the real hall).
  const colGeo = new THREE.BoxGeometry(0.3, 7.5, 0.3);
  for (let x = Math.ceil(dockWallX / 12) * 12; x < b.maxX + 6; x += 12) {
    const col = new THREE.Mesh(colGeo, YELLOW);
    col.position.set(x, 3.75, wallStart + 0.4);
    col.castShadow = true;
    root.add(col);
  }

  const outboundRoute = (door: number): P2[] => {
    const z = laneZs[door % laneZs.length];
    return [...ob, { x: spineX, z }, { x: laneEndX, z }];
  };
  const stackSlot = (door: number, i: number): THREE.Vector3 => {
    const z0 = doorZs[door % doorZs.length];
    const perLayer = 6 * 5;
    const layer = Math.floor(i / perLayer);
    const r = i % perLayer;
    const col = r % 6;
    const row = Math.floor(r / 6);
    return new THREE.Vector3(dockWallX + 0.75 + row * 0.66, layer * 0.31, z0 - 1.35 + col * 0.42);
  };

  return { root, stations, docks, outboundRoute, stackSlot };
}

export function cellPoint(layout: Layout, cell: number): P2 & { heading: number } {
  return loopCellPoint(layout, cell);
}

/** Cubic Bézier between two points whose ends both run along `t` (an S-bend when they are offset sideways). */
export function sBend(p0: P2, p3: P2, t: P2, f: number): P2 & { yaw: number } {
  const along = (p3.x - p0.x) * t.x + (p3.z - p0.z) * t.z;
  const h = Math.max(0.05, along) * 0.42;
  const p1 = { x: p0.x + t.x * h, z: p0.z + t.z * h };
  const p2 = { x: p3.x - t.x * h, z: p3.z - t.z * h };
  const u = 1 - f;
  const b0 = u * u * u, b1 = 3 * u * u * f, b2 = 3 * u * f * f, b3 = f * f * f;
  const d0 = 3 * u * u, d1 = 6 * u * f, d2 = 3 * f * f;
  const dx = d0 * (p1.x - p0.x) + d1 * (p2.x - p1.x) + d2 * (p3.x - p2.x);
  const dz = d0 * (p1.z - p0.z) + d1 * (p2.z - p1.z) + d2 * (p3.z - p2.z);
  return {
    x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    z: b0 * p0.z + b1 * p1.z + b2 * p2.z + b3 * p3.z,
    yaw: Math.atan2(-dz, dx),
  };
}

/** Cubic Bézier from p0 heading t0 to p3 heading t3 (unit vectors), with yaw along the curve. */
export function bend(p0: P2, t0: P2, p3: P2, t3: P2, f: number): P2 & { yaw: number } {
  const h = Math.hypot(p3.x - p0.x, p3.z - p0.z) * 0.45;
  const p1 = { x: p0.x + t0.x * h, z: p0.z + t0.z * h };
  const p2 = { x: p3.x - t3.x * h, z: p3.z - t3.z * h };
  const u = 1 - f;
  const b0 = u * u * u, b1 = 3 * u * u * f, b2 = 3 * u * f * f, b3 = f * f * f;
  const d0 = 3 * u * u, d1 = 6 * u * f, d2 = 3 * f * f;
  const dx = d0 * (p1.x - p0.x) + d1 * (p2.x - p1.x) + d2 * (p3.x - p2.x);
  const dz = d0 * (p1.z - p0.z) + d1 * (p2.z - p1.z) + d2 * (p3.z - p2.z);
  return { x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x, z: b0 * p0.z + b1 * p1.z + b2 * p2.z + b3 * p3.z, yaw: Math.atan2(-dz, dx) };
}

/** Direction of travel on the loop at a (fractional) cell. */
export function loopTangent(layout: Layout, cell: number): P2 {
  const a = cellPoint(layout, cell - 0.05);
  const b = cellPoint(layout, cell + 0.05);
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
}

/** Direction boxes travel along the induction lane (towards the loop). */
export function inductTangent(layout: Layout): P2 {
  const [a, b] = layout.inductLane;
  const l = Math.hypot(a.x - b.x, a.z - b.z) || 1;
  return { x: (a.x - b.x) / l, z: (a.z - b.z) / l };
}

/** The induction lane's last stretch: a bend from the head of the queue onto the loop, joining it tangentially. */
function inductPath(layout: Layout): { bend: P2[] } {
  const p0 = layout.inductLane[0];
  const t0 = inductTangent(layout);
  const end = layout.inductCell + 0.5;
  const p3 = cellPoint(layout, end);
  const t3 = loopTangent(layout, end);
  const pts: P2[] = [];
  for (let i = 0; i <= 24; i++) pts.push(bend(p0, t0, p3, t3, i / 24));
  return { bend: pts };
}

/** Lead-in on the loop before the divert (and run-out after the merge), in cells. */
const BEND_LEAD = 0.7;
/** Where a side track's centreline leaves the loop, sideways from the loop's centreline. */
const BEND_START = 0.1;

/** Centreline of a station's side track: a smooth S-bend off the loop, the straight run, and an S-bend back on. */
function sideTrackPath(layout: Layout, g: StationGeom): P2[] {
  const t = g.tangent;
  const n = g.normal;
  const at = (cell: number): P2 => {
    const p = cellPoint(layout, cell);
    return { x: p.x + n.x * BEND_START, z: p.z + n.z * BEND_START };
  };
  const first = g.inLane[0];
  const last = g.outLane[0];
  const pts: P2[] = [];
  const N = 24;
  const start = at(g.divertCell - BEND_LEAD);
  for (let i = 0; i <= N; i++) pts.push(sBend(start, first, t, i / N));
  const end = at(g.mergeCell + BEND_LEAD);
  for (let i = 0; i <= N; i++) pts.push(sBend(last, end, t, i / N));
  return pts;
}

function distToSegment(p: P2, a: P2, b: P2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const f = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * f, p.z - a.z - dz * f);
}

function makeTruck(tex: THREE.Texture): THREE.Group {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.4, metalness: 0.2 });
  const side = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, metalness: 0.1 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(5.2, 2.5, 2.3), [white, white, white, white, side, side]);
  body.position.set(0.6, 1.75, 0);
  body.castShadow = true;
  g.add(body);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.0, 2.2), new THREE.MeshStandardMaterial({ color: 0x1d1d1b, roughness: 0.35, metalness: 0.4 }));
  cab.position.set(-2.8, 1.45, 0);
  cab.castShadow = true;
  g.add(cab);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.8), new THREE.MeshStandardMaterial({ color: 0x8fb3c9, roughness: 0.05, metalness: 0.6 }));
  glass.rotation.y = -Math.PI / 2;
  glass.position.set(-3.61, 1.9, 0);
  g.add(glass);
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 18).rotateX(Math.PI / 2);
  const tyre = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  for (const x of [-2.8, 1.8]) for (const z of [-1.05, 1.05]) {
    const w = new THREE.Mesh(wheelGeo, tyre);
    w.position.set(x, 0.42, z);
    g.add(w);
  }
  return g;
}
