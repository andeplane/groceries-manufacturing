import { Rng } from './rng';
import { ZONES, type Catalog, type Zone } from './catalog';
import type { SlottingStrategy } from './config';

export interface Slotting {
  /** Station index for each product id. */
  stationOf: Map<number, number>;
  /** Temperature zone of each station. */
  stationZone: Zone[];
  /** Product ids on each station, most popular first. */
  productsAt: number[][];
  /** Expected units/order handled by each station (from history). */
  expectedLoad: Float64Array;
}

/**
 * Assign products to stations. Stations are split between temperature zones in proportion to
 * expected units, laid out along the loop as ambient → chilled → frozen.
 */
export function buildSlotting(
  catalog: Catalog,
  expectedUnits: Float64Array,
  stations: number,
  strategy: SlottingStrategy,
  seed: number,
): Slotting {
  const rng = new Rng(seed ^ 0x51077);
  const products = catalog.products;
  const zoneDemand = ZONES.map((z) => products.reduce((s, p, i) => s + (p.zone === z ? expectedUnits[i] + 1e-6 : 0), 0));
  const total = zoneDemand.reduce((a, b) => a + b, 0);
  // Largest-remainder allocation with at least one station per non-empty zone.
  const present = ZONES.map((z) => products.some((p) => p.zone === z));
  const nZone: number[] = ZONES.map((_, k) => (present[k] ? 1 : 0));
  let remaining = stations - nZone.reduce((a, b) => a + b, 0);
  const ideal = zoneDemand.map((d) => (d / total) * stations);
  while (remaining > 0) {
    let best = -1;
    let bestGap = -Infinity;
    for (let k = 0; k < ZONES.length; k++) {
      if (!present[k]) continue;
      const gap = ideal[k] - nZone[k];
      if (gap > bestGap) {
        bestGap = gap;
        best = k;
      }
    }
    nZone[best]++;
    remaining--;
  }

  const stationZone: Zone[] = [];
  ZONES.forEach((z, k) => {
    for (let i = 0; i < nZone[k]; i++) stationZone.push(z);
  });

  const stationOf = new Map<number, number>();
  const load = new Float64Array(stations);
  let base = 0;
  ZONES.forEach((z, k) => {
    const n = nZone[k];
    if (n === 0) return;
    const idxs = products.map((p, i) => (p.zone === z ? i : -1)).filter((i) => i >= 0);
    const ids = (local: number) => base + local;
    if (strategy === 'random') {
      for (const i of idxs) {
        const s = ids(rng.int(n));
        stationOf.set(products[i].id, s);
        load[s] += expectedUnits[i];
      }
    } else if (strategy === 'category') {
      // Contiguous runs of categories, cut into equal-demand chunks: whole shelves end up together.
      idxs.sort((a, b) => {
        const pa = products[a];
        const pb = products[b];
        return pa.cat.localeCompare(pb.cat) || pa.sub.localeCompare(pb.sub) || pa.name.localeCompare(pb.name);
      });
      const zt = idxs.reduce((s, i) => s + expectedUnits[i], 0);
      let acc = 0;
      for (const i of idxs) {
        const local = Math.min(n - 1, Math.floor((acc / zt) * n));
        const s = ids(local);
        stationOf.set(products[i].id, s);
        load[s] += expectedUnits[i];
        acc += expectedUnits[i];
      }
    } else {
      // Longest-processing-time greedy: most popular first onto the least-loaded station.
      // 'spread' also penalises stacking the same sub-category on one station, so a surge in
      // one kind of product (taco night) is spread across all stations.
      idxs.sort((a, b) => expectedUnits[b] - expectedUnits[a] || products[a].id - products[b].id);
      const subLoad: Map<string, number>[] = Array.from({ length: n }, () => new Map());
      const count = new Int32Array(n);
      const maxCount = Math.ceil(idxs.length / n) + 2;
      for (const i of idxs) {
        const p = products[i];
        let best = 0;
        let bestCost = Infinity;
        const offset = rng.int(n);
        for (let jj = 0; jj < n; jj++) {
          const j = (jj + offset) % n;
          if (count[j] >= maxCount) continue;
          let cost = load[ids(j)];
          if (strategy === 'spread') cost += 4 * (subLoad[j].get(p.sub) ?? 0);
          if (cost < bestCost) {
            bestCost = cost;
            best = j;
          }
        }
        const s = ids(best);
        stationOf.set(p.id, s);
        load[s] += expectedUnits[i];
        count[best]++;
        subLoad[best].set(p.sub, (subLoad[best].get(p.sub) ?? 0) + expectedUnits[i]);
      }
    }
    base += n;
  });

  const productsAt: number[][] = Array.from({ length: stations }, () => []);
  const pIndex = new Map(products.map((p, i) => [p.id, i]));
  for (const [id, s] of stationOf) productsAt[s].push(id);
  for (const list of productsAt) list.sort((a, b) => expectedUnits[pIndex.get(b)!] - expectedUnits[pIndex.get(a)!]);

  return { stationOf, stationZone, productsAt, expectedLoad: load };
}
