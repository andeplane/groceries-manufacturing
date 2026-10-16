import { ZONES, productVolumeL, type Catalog, type Zone } from './catalog';
import type { BoxingStrategy } from './config';
import type { Order } from './demand';
import type { Slotting } from './slotting';

export interface BoxItem {
  productId: number;
  qty: number;
  station: number;
}

export interface BoxPlan {
  zone: Zone;
  items: BoxItem[];
  units: number;
  volume: number;
  kg: number;
  /** Distinct stations this box must visit, ascending. */
  stations: number[];
}

/**
 * Split an order into boxes. Boxes never mix temperature zones and respect volume/weight limits.
 * - zone-fill: first-fit decreasing by volume → fewest boxes.
 * - station-aware: fill boxes in station order → fewest station stops per box.
 */
export function planBoxes(
  order: Order,
  catalog: Catalog,
  slotting: Slotting,
  strategy: BoxingStrategy,
  boxVolume: number,
  boxMaxKg: number,
): BoxPlan[] {
  const out: BoxPlan[] = [];
  for (const zone of ZONES) {
    type Unit = { productId: number; station: number; vol: number; kg: number };
    const units: Unit[] = [];
    for (const l of order.lines) {
      const p = catalog.byId.get(l.productId)!;
      if (p.zone !== zone) continue;
      const station = slotting.stationOf.get(p.id)!;
      const vol = Math.min(boxVolume, productVolumeL(p) * 1.15);
      const kg = Math.min(boxMaxKg, p.kg);
      for (let q = 0; q < l.qty; q++) units.push({ productId: p.id, station, vol, kg });
    }
    if (!units.length) continue;
    const boxes: { units: Unit[]; vol: number; kg: number }[] = [];
    if (strategy === 'station-aware') {
      units.sort((a, b) => a.station - b.station || b.vol - a.vol);
      let cur = { units: [] as Unit[], vol: 0, kg: 0 };
      for (const u of units) {
        if (cur.units.length && (cur.vol + u.vol > boxVolume || cur.kg + u.kg > boxMaxKg)) {
          boxes.push(cur);
          cur = { units: [], vol: 0, kg: 0 };
        }
        cur.units.push(u);
        cur.vol += u.vol;
        cur.kg += u.kg;
      }
      boxes.push(cur);
    } else {
      units.sort((a, b) => b.vol - a.vol);
      for (const u of units) {
        let placed = false;
        for (const b of boxes) {
          if (b.vol + u.vol <= boxVolume && b.kg + u.kg <= boxMaxKg) {
            b.units.push(u);
            b.vol += u.vol;
            b.kg += u.kg;
            placed = true;
            break;
          }
        }
        if (!placed) boxes.push({ units: [u], vol: u.vol, kg: u.kg });
      }
    }
    for (const b of boxes) {
      const lines = new Map<number, BoxItem>();
      for (const u of b.units) {
        const it = lines.get(u.productId);
        if (it) it.qty++;
        else lines.set(u.productId, { productId: u.productId, qty: 1, station: u.station });
      }
      const items = [...lines.values()].sort((a, c) => a.station - c.station);
      out.push({
        zone,
        items,
        units: b.units.length,
        volume: b.vol,
        kg: b.kg,
        stations: [...new Set(items.map((i) => i.station))].sort((a, c) => a - c),
      });
    }
  }
  return out;
}
