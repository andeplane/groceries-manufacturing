/**
 * Headless run: npm run sim -- --hours 4 --slotting spread --cacheSize 5 --theme taco
 * Any SimConfig key can be passed as --key value. Prints a metrics summary (or --json).
 */
import { DEFAULT_CONFIG, Simulation, type SimConfig, type SimStats } from '../core';
import { loadProducts } from './load';

export function parseArgs(argv: string[]): { config: Partial<SimConfig>; hours: number; warmup: number; json: boolean } {
  const config: Record<string, unknown> = {};
  let hours = 4;
  let warmup = 0.5;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'json') {
      json = true;
      continue;
    }
    const val = argv[++i];
    if (key === 'hours') hours = Number(val);
    else if (key === 'warmup') warmup = Number(val);
    else if (key in DEFAULT_CONFIG) {
      const def = DEFAULT_CONFIG[key as keyof SimConfig];
      config[key] = typeof def === 'number' ? Number(val) : val;
    } else throw new Error(`Unknown option --${key}`);
  }
  return { config: config as Partial<SimConfig>, hours, warmup, json };
}

export function runHeadless(config: Partial<SimConfig>, hours: number, warmup: number) {
  const sim = new Simulation({ products: loadProducts(), config });
  const t0 = performance.now();
  sim.run(warmup * 3600);
  sim.resetMeasurement();
  sim.run(hours * 3600);
  const wall = (performance.now() - t0) / 1000;
  return { sim, stats: sim.stats(), wall };
}

export function summarize(s: SimStats): string {
  const f = (x: number, d = 0) => x.toFixed(d);
  const util = s.utilization;
  const mean = util.reduce((a, b) => a + b, 0) / util.length;
  return [
    `UPH                 ${f(s.uph)}  (last 10 min ${f(s.uphRecent)})`,
    `units packed        ${s.unitsPacked}`,
    `orders arrived/shipped ${s.ordersArrived} / ${s.ordersShipped}`,
    `boxes in system     ${s.boxesInSystem}  waiting to induct ${s.boxesWaiting}`,
    `units/box           ${f(s.unitsPerBox, 1)}   stops/box ${f(s.stopsPerBox, 2)}   laps/box ${f(s.lapsPerBox, 2)}   missed diverts/box ${f(s.missedDivertsPerBox, 2)}`,
    `box cycle           mean ${f(s.boxCycleMean)} s   p95 ${f(s.boxCycleP95)} s`,
    `trips departed      ${s.tripsDeparted}   dock wait mean ${f(s.dockWaitMean / 60, 1)} min  p95 ${f(s.dockWaitP95 / 60, 1)}  max ${f(s.dockWaitMax / 60, 1)}   lead ${f(s.tripLeadMean / 60, 1)} min`,
    `station util        mean ${f(mean * 100)}%  min ${f(Math.min(...util) * 100)}%  max ${f(Math.max(...util) * 100)}%   blocked max ${f(Math.max(...s.blocked) * 100)}%`,
    `loop occupancy      ${f(s.loopOccupancy * 100)}%`,
  ].join('\n');
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  const { config, hours, warmup, json } = parseArgs(process.argv.slice(2));
  const { stats, wall } = runHeadless(config, hours, warmup);
  if (json) console.log(JSON.stringify(stats));
  else {
    console.log(summarize(stats));
    console.log(`(${hours + warmup} sim-hours in ${wall.toFixed(2)} s wall → ${(((hours + warmup) * 3600) / wall).toFixed(0)}× real time)`);
  }
}
