/**
 * Compare strategies headlessly: npm run sweep -- --hours 3 --orderRate 700
 * Runs every slotting × release combination (optionally with a theme surge) and prints a table.
 */
import { RELEASE_POLICIES, SLOTTING_STRATEGIES, type SimConfig } from '../core';
import { parseArgs, runHeadless } from './run';

const { config, hours, warmup } = parseArgs(process.argv.slice(2));
const rows: string[][] = [['slotting', 'release', 'theme', 'UPH', 'util min/mean/max %', 'stops/box', 'laps/box', 'dock wait mean/max min', 'lead min']];
const themes = config.theme ? [config.theme] : (['none', 'taco'] as const);
for (const theme of themes) {
  for (const slotting of SLOTTING_STRATEGIES) {
    for (const release of RELEASE_POLICIES) {
      const c: Partial<SimConfig> = { ...config, slotting, release, theme };
      const { stats: s } = runHeadless(c, hours, warmup);
      const u = s.utilization;
      const mean = u.reduce((a, b) => a + b, 0) / u.length;
      rows.push([
        slotting,
        release,
        theme,
        s.uph.toFixed(0),
        `${(Math.min(...u) * 100).toFixed(0)}/${(mean * 100).toFixed(0)}/${(Math.max(...u) * 100).toFixed(0)}`,
        s.stopsPerBox.toFixed(2),
        s.lapsPerBox.toFixed(2),
        `${(s.dockWaitMean / 60).toFixed(1)}/${(s.dockWaitMax / 60).toFixed(1)}`,
        (s.tripLeadMean / 60).toFixed(1),
      ]);
    }
  }
}
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join('  '));
