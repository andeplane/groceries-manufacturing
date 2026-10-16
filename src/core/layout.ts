import type { SimConfig } from './config';

/** 2D point on the floor plane: x along the loop's straights, z across. (y is up in the viewer.) */
export interface P2 {
  x: number;
  z: number;
}

export interface StationGeom {
  index: number;
  /** Loop cell where boxes divert into the station's in-lane. */
  divertCell: number;
  /** Loop cell where finished boxes merge back. */
  mergeCell: number;
  /** Unit vector pointing away from the loop (towards the worker). */
  normal: P2;
  /** Unit vector along the loop's direction of travel at the station. */
  tangent: P2;
  /** Centre of in-lane cell i (0 = next to the loop, cacheSize-1 = pack position). */
  inLane: P2[];
  /** Centre of out-lane cell j (0 = next to the loop). */
  outLane: P2[];
  worker: P2;
  rack: P2;
  side: 'south' | 'north';
}

export interface Layout {
  cells: number;
  cellLength: number;
  radius: number;
  straight: number;
  perimeter: number;
  stations: StationGeom[];
  inductCell: number;
  exitCell: number;
  /** Where the box erector sits and empty boxes queue. */
  inductLane: P2[];
  /** Polyline from the exit cell to the dock spine. */
  outboundPath: P2[];
  docks: { door: P2; lane: P2[] }[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Distance from loop to spur start. */
  spurOffset: number;
}

const SPUR_OFFSET = 0.9;
const MARGIN_CELLS = 2;

/**
 * Build the loop: a stadium (two straights + two semicircles), travelling east along the south
 * straight and west along the north one. Stations hang off the outside of both straights.
 */
export function buildLayout(cfg: SimConfig): Layout {
  const perSouth = Math.ceil(cfg.stations / 2);
  const perNorth = cfg.stations - perSouth;
  const straightCells = MARGIN_CELLS * 2 + Math.max(perSouth, perNorth) * cfg.stationSpacing;
  const cellLength = cfg.cellLength;
  const straight = straightCells * cellLength;
  // Pick a radius that makes the curves a whole number of cells.
  const curveCells = Math.max(8, Math.round((Math.PI * 3.2) / cellLength));
  const radius = (curveCells * cellLength) / Math.PI;
  const cells = 2 * straightCells + 2 * curveCells;
  const perimeter = cells * cellLength;

  const loop = (cell: number) => loopPoint(cell * cellLength, straight, radius, perimeter);

  const stations: StationGeom[] = [];
  for (let k = 0; k < cfg.stations; k++) {
    const south = k < perSouth;
    const local = south ? k : k - perSouth;
    const startCell = south ? 0 : straightCells + curveCells;
    const divertCell = startCell + MARGIN_CELLS + local * cfg.stationSpacing;
    const mergeCell = divertCell + 1;
    const a = loop(divertCell);
    const b = loop(mergeCell);
    const tangent = { x: south ? 1 : -1, z: 0 };
    const normal = { x: 0, z: south ? 1 : -1 };
    const inLane: P2[] = [];
    const outLane: P2[] = [];
    for (let i = 0; i < cfg.cacheSize; i++) {
      const off = SPUR_OFFSET + i * cellLength;
      inLane.push({ x: a.x + normal.x * off, z: a.z + normal.z * off });
      outLane.push({ x: b.x + normal.x * off, z: b.z + normal.z * off });
    }
    const end = SPUR_OFFSET + cfg.cacheSize * cellLength;
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    stations.push({
      index: k,
      divertCell,
      mergeCell,
      normal,
      tangent,
      inLane,
      outLane,
      worker: { x: mid.x + normal.x * (end + 0.15), z: mid.z + normal.z * (end + 0.15) },
      rack: { x: mid.x + normal.x * (end + 1.0), z: mid.z + normal.z * (end + 1.0) },
      side: south ? 'south' : 'north',
    });
  }

  // West curve hosts the exit (upper-left) and the induction (lower-left).
  const westStart = 2 * straightCells + curveCells;
  const exitCell = westStart + Math.round(curveCells * 0.3);
  const inductCell = westStart + Math.round(curveCells * 0.75);
  const ep = loop(exitCell);
  const ip = loop(inductCell);
  const westX = -straight / 2 - radius;
  const spineX = westX - 6;

  const inductLane: P2[] = [];
  for (let i = 0; i < 6; i++) inductLane.push({ x: ip.x - 1.0 - i * cellLength, z: ip.z + 0.6 + i * 0.25 });

  const outboundPath: P2[] = [ep, { x: ep.x - 1.5, z: ep.z - 0.6 }, { x: spineX, z: ep.z - 0.6 }];
  const doors = cfg.dockDoors;
  const doorPitch = 4.2;
  const dockWallX = spineX - 7;
  const docks = [];
  const z0 = -((doors - 1) * doorPitch) / 2;
  for (let d = 0; d < doors; d++) {
    const z = z0 + d * doorPitch;
    docks.push({
      door: { x: dockWallX, z },
      lane: [
        { x: spineX, z },
        { x: dockWallX + 1.5, z },
      ],
    });
  }

  const maxOut = SPUR_OFFSET + cfg.cacheSize * cellLength + 2.5;
  const bounds = {
    minX: dockWallX - 9,
    maxX: straight / 2 + radius + 4,
    minZ: -radius - maxOut - 2,
    maxZ: radius + maxOut + 2,
  };
  bounds.minZ = Math.min(bounds.minZ, z0 - 4);
  bounds.maxZ = Math.max(bounds.maxZ, -z0 + 4);

  return {
    cells,
    cellLength,
    radius,
    straight,
    perimeter,
    stations,
    inductCell,
    exitCell,
    inductLane,
    outboundPath,
    docks,
    bounds,
    spurOffset: SPUR_OFFSET,
  };
}

/** Point and heading (radians, 0 = +x, measured towards +z) at arc length s along the loop. */
export function loopPoint(s: number, straight: number, radius: number, perimeter: number): P2 & { heading: number } {
  s = ((s % perimeter) + perimeter) % perimeter;
  const h = straight / 2;
  const arc = Math.PI * radius;
  if (s < straight) return { x: -h + s, z: radius, heading: 0 };
  s -= straight;
  if (s < arc) {
    // East curve: centre (h, 0), from +z round through +x to -z.
    const a = s / radius;
    return { x: h + radius * Math.sin(a), z: radius * Math.cos(a), heading: -a };
  }
  s -= arc;
  if (s < straight) return { x: h - s, z: -radius, heading: Math.PI };
  s -= straight;
  const a = s / radius;
  // West curve: centre (-h, 0), from -z round through -x to +z.
  return { x: -h - radius * Math.sin(a), z: -radius * Math.cos(a), heading: Math.PI - a };
}

export function loopCellPoint(layout: Layout, cell: number): P2 & { heading: number } {
  return loopPoint(cell * layout.cellLength, layout.straight, layout.radius, layout.perimeter);
}
