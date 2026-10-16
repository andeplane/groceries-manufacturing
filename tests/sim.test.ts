import { describe, expect, it } from 'vitest';
import { Loc, Simulation, SLOTTING_STRATEGIES, RELEASE_POLICIES, planBoxes } from '../src/core';
import { loadProducts } from '../src/cli/load';

const products = loadProducts();

function invariants(sim: Simulation) {
  const seen = new Set<number>();
  for (const b of sim.loop) if (b) {
    expect(b.loc).toBe(Loc.Loop);
    expect(seen.has(b.id)).toBe(false);
    seen.add(b.id);
  }
  for (const st of sim.stations) {
    expect(st.inLane.length).toBe(sim.cfg.cacheSize);
    for (const b of [...st.inLane, ...st.outLane]) if (b) {
      expect(seen.has(b.id)).toBe(false);
      seen.add(b.id);
      expect(b.station).toBe(st.index);
    }
  }
  expect(seen.size).toBe(sim.inSystem());
}

describe('simulation', () => {
  it('is deterministic for a seed', () => {
    const a = new Simulation({ products, config: { seed: 7 } });
    const b = new Simulation({ products, config: { seed: 7 } });
    a.run(1800);
    b.run(1800);
    expect(a.stats().unitsPacked).toBe(b.stats().unitsPacked);
    expect(a.stats().unitsPacked).toBeGreaterThan(1000);
  });

  it('keeps boxes consistent and visits only the right stations', () => {
    const sim = new Simulation({ products, config: { cacheSize: 3 } });
    for (let i = 0; i < 2000; i++) {
      sim.step();
      if (i % 97 === 0) invariants(sim);
    }
    for (const b of sim.boxes.values()) {
      for (const u of b.placed) expect(sim.slotting.stationOf.get(u.productId)).toBe(u.station);
      if (b.loc >= Loc.Outbound) {
        expect(b.remaining.length).toBe(0);
        expect(b.placed.length).toBe(b.units);
      }
    }
  });

  it('never mixes temperature zones or overfills a box', () => {
    const sim = new Simulation({ products });
    const rng = { n: 0 };
    for (let k = 0; k < 200; k++) {
      const o = sim.demand.sample((sim as unknown as { rng: never }).rng, k, 0, 0, null);
      rng.n += o.units;
      for (const strategy of ['zone-fill', 'station-aware'] as const) {
        const boxes = planBoxes(o, sim.catalog, sim.slotting, strategy, sim.cfg.boxVolume, sim.cfg.boxMaxKg);
        expect(boxes.reduce((s, b) => s + b.units, 0)).toBe(o.units);
        for (const b of boxes) {
          for (const it of b.items) expect(sim.catalog.byId.get(it.productId)!.zone).toBe(b.zone);
          if (b.units > 1) expect(b.volume).toBeLessThanOrEqual(sim.cfg.boxVolume + 1e-9);
        }
      }
    }
    expect(rng.n / 200).toBeGreaterThan(10);
  });

  it('orders are realistic in value', () => {
    const sim = new Simulation({ products });
    let v = 0;
    for (let k = 0; k < 500; k++) v += sim.demand.sample((sim as unknown as { rng: never }).rng, k, 0, 0, null).value;
    expect(v / 500).toBeGreaterThan(1000);
    expect(v / 500).toBeLessThan(1600);
  });

  it('runs every strategy combination', () => {
    for (const slotting of SLOTTING_STRATEGIES) {
      for (const release of RELEASE_POLICIES) {
        const sim = new Simulation({ products, config: { slotting, release } });
        sim.run(1200);
        const s = sim.stats();
        expect(s.unitsPacked).toBeGreaterThan(0);
        expect(s.utilization.every((u) => u >= 0 && u <= 1)).toBe(true);
      }
    }
  });

  it('category slotting clogs under a taco surge, spread does not', () => {
    const run = (slotting: 'category' | 'spread') => {
      const sim = new Simulation({ products, config: { slotting, theme: 'taco', orderRate: 800 } });
      sim.run(1800);
      sim.resetMeasurement();
      sim.run(3600);
      return Math.max(...sim.stats().utilization);
    };
    expect(run('category')).toBeGreaterThan(run('spread'));
  });
});
