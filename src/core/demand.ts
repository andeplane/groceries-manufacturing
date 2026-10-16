import { AliasTable, Rng, hash32 } from './rng';
import type { Catalog, Product } from './catalog';
import type { Theme } from './config';

export interface OrderLine {
  productId: number;
  qty: number;
}

export interface Order {
  id: number;
  arrivedAt: number;
  route: number;
  lines: OrderLine[];
  value: number;
  units: number;
  theme: Theme | null;
}

/**
 * How "staple" a top-level category is: how often a typical basket reaches into it.
 * Hand-tuned to give a plausible Norwegian grocery basket (lots of dairy, fruit/veg, bread).
 */
const CATEGORY_STAPLE: Record<string, number> = {
  'Frukt og grønt': 3.2,
  'Meieri, ost og egg': 3.4,
  'Bakeri og konditori': 2.0,
  'Pålegg': 2.0,
  'Kylling og kjøtt': 2.2,
  'Middager og tilbehør': 1.8,
  'Fisk og sjømat': 1.0,
  'Drikke': 1.6,
  'Sjokolade, snacks og godteri': 1.2,
  'Iskrem, dessert og kjeks': 0.8,
  'Frokostblandinger og müsli': 0.8,
  'Bakeingredienser': 0.6,
  'Hus og hjem': 0.6,
  'Hygiene og skjønnhet': 0.5,
  'Baby og barn': 0.4,
  'Grill': 0.4,
  'Plantebasert': 0.3,
  'Dyr': 0.3,
  'Legemidler og helsekost': 0.2,
  'Trening': 0.15,
  'Bursdag og fest': 0.15,
  'Blomster og planter': 0.15,
};

/** Meal/occasion clusters. Categories sharing a cluster are likely to follow each other in a basket. */
const CLUSTERS: string[][] = [
  ['Meieri, ost og egg', 'Bakeri og konditori', 'Pålegg', 'Frokostblandinger og müsli', 'Frukt og grønt', 'Drikke'],
  ['Middager og tilbehør', 'Kylling og kjøtt', 'Fisk og sjømat', 'Frukt og grønt', 'Meieri, ost og egg', 'Plantebasert'],
  ['Sjokolade, snacks og godteri', 'Drikke', 'Iskrem, dessert og kjeks', 'Bursdag og fest'],
  ['Hus og hjem', 'Hygiene og skjønnhet', 'Baby og barn', 'Dyr', 'Legemidler og helsekost'],
  ['Bakeingredienser', 'Meieri, ost og egg', 'Iskrem, dessert og kjeks', 'Bursdag og fest'],
  ['Grill', 'Kylling og kjøtt', 'Drikke', 'Frukt og grønt', 'Middager og tilbehør'],
];

/** Keyword bundles for themed surges (matched against product name, lower-cased). */
export const THEME_KEYWORDS: Record<Exclude<Theme, 'none'>, string[]> = {
  taco: ['taco', 'tortilla', 'salsa', 'nachos', 'guacamole', 'jalapeñ', 'jalapen', 'tacokrydder', 'rømme', 'kjøttdeig', 'isbergsalat', 'mais', 'avokado', 'revet'],
  grill: ['grill', 'pølse', 'burger', 'kotelett', 'marinert', 'kull', 'potetsalat', 'ketchup', 'sennep', 'lompe'],
  party: ['chips', 'brus', 'cola', 'pepsi', 'solo', 'godteri', 'potetgull', 'popcorn', 'dip', 'servietter', 'ballong'],
};

export interface DemandModel {
  /** Draw one order. `theme` adds a themed bundle to the basket. */
  sample(rng: Rng, id: number, t: number, route: number, theme: Theme | null): Order;
  /** Expected units per order for each product (index-aligned with catalog.products). */
  expectedUnits: Float64Array;
  /** Index of each product in catalog.products. */
  indexOf: Map<number, number>;
  themeProducts(theme: Theme): number[];
}

export interface DemandOptions {
  avgOrderValue: number;
}

export function buildDemandModel(catalog: Catalog, opts: DemandOptions): DemandModel {
  const products = catalog.products;
  const indexOf = new Map<number, number>();
  products.forEach((p, i) => indexOf.set(p.id, i));

  // Group by category / sub-category.
  const cats = [...new Set(products.map((p) => p.cat))];
  const catIndex = new Map(cats.map((c, i) => [c, i]));
  const byCat: number[][] = cats.map(() => []);
  const subsOfCat: Map<string, number[]>[] = cats.map(() => new Map());
  products.forEach((p, i) => {
    const ci = catIndex.get(p.cat)!;
    byCat[ci].push(i);
    const m = subsOfCat[ci];
    if (!m.has(p.sub)) m.set(p.sub, []);
    m.get(p.sub)!.push(i);
  });

  // Seed-independent product popularity: Zipf within each sub-category over a hash-shuffled rank,
  // nudged towards cheaper items. A few products dominate each shelf, like in real data.
  const pop = new Float64Array(products.length);
  for (const m of subsOfCat) {
    for (const idxs of m.values()) {
      const ranked = [...idxs].sort((a, b) => hash32(products[a].id) - hash32(products[b].id));
      ranked.forEach((pi, rank) => {
        const price = products[pi].price;
        pop[pi] = (1 / Math.pow(rank + 1, 1.05)) * Math.pow(60 / (price + 25), 0.35);
      });
    }
  }

  const productTables = byCat.map((idxs) => new AliasTable(idxs.map((i) => pop[i])));
  const subTables = new Map<string, { idxs: number[]; table: AliasTable }>();
  for (const m of subsOfCat) {
    for (const [sub, idxs] of m) {
      subTables.set(sub, { idxs, table: new AliasTable(idxs.map((i) => pop[i])) });
    }
  }

  // Category weights and a Markov transition matrix built from shared meal clusters.
  const catWeight = cats.map((c, i) => (CATEGORY_STAPLE[c] ?? 0.05) * Math.sqrt(byCat[i].length / 100));
  const startTable = new AliasTable(catWeight);
  const clusterOf = cats.map((c) => CLUSTERS.map((cl, k) => (cl.includes(c) ? k : -1)).filter((k) => k >= 0));
  const transTables = cats.map((_, a) =>
    new AliasTable(
      cats.map((__, b) => {
        const shared = clusterOf[a].filter((k) => clusterOf[b].includes(k)).length;
        return catWeight[b] * (1 + 2.5 * shared) * (a === b ? 0.6 : 1);
      }),
    ),
  );

  const themeCache = new Map<Theme, number[]>();
  const themeProducts = (theme: Theme): number[] => {
    if (theme === 'none') return [];
    if (!themeCache.has(theme)) {
      const kws = THEME_KEYWORDS[theme];
      themeCache.set(
        theme,
        products.map((p, i) => (kws.some((k) => p.name.toLowerCase().includes(k)) ? i : -1)).filter((i) => i >= 0),
      );
    }
    return themeCache.get(theme)!;
  };

  const sampleQty = (rng: Rng, p: Product): number => {
    const r = rng.next();
    const cheap = p.price < 30 ? 1.6 : 1;
    if (r < 0.74 / cheap) return 1;
    if (r < 0.93) return 2;
    if (r < 0.985) return 3;
    return 4 + rng.int(3);
  };

  const sample = (rng: Rng, id: number, t: number, route: number, theme: Theme | null): Order => {
    const target = Math.min(6000, Math.max(250, rng.lognormal(opts.avgOrderValue, 0.5)));
    const lines = new Map<number, number>();
    let value = 0;
    const add = (pi: number, qty: number) => {
      lines.set(pi, (lines.get(pi) ?? 0) + qty);
      value += products[pi].price * qty;
    };
    if (theme && theme !== 'none') {
      const tp = themeProducts(theme);
      if (tp.length) {
        const n = 4 + rng.int(5);
        for (let k = 0; k < n; k++) add(rng.pick(tp), 1);
      }
    }
    let ci = startTable.sample(rng);
    let lastSub: string | null = null;
    let guard = 0;
    while (value < target && guard++ < 400) {
      let pi: number;
      if (lastSub && rng.next() < 0.22) {
        const st = subTables.get(lastSub)!;
        pi = st.idxs[st.table.sample(rng)];
      } else {
        if (byCat[ci].length === 0) {
          ci = startTable.sample(rng);
          continue;
        }
        pi = byCat[ci][productTables[ci].sample(rng)];
      }
      const p = products[pi];
      if (lines.has(pi) && rng.next() < 0.7) {
        // Already in basket: mostly skip, sometimes bump quantity.
      } else {
        add(pi, lines.has(pi) ? 1 : sampleQty(rng, p));
      }
      lastSub = p.sub;
      ci = transTables[ci].sample(rng);
    }
    const out: OrderLine[] = [];
    let units = 0;
    for (const [pi, qty] of lines) {
      out.push({ productId: products[pi].id, qty });
      units += qty;
    }
    return { id, arrivedAt: t, route, lines: out, value, units, theme: theme && theme !== 'none' ? theme : null };
  };

  // Expected units per product from a Monte Carlo "order history" (what a planner would know).
  const expectedUnits = new Float64Array(products.length);
  const hist = new Rng(0xda7a);
  const N = 4000;
  for (let k = 0; k < N; k++) {
    const o = sample(hist, k, 0, 0, null);
    for (const l of o.lines) expectedUnits[indexOf.get(l.productId)!] += l.qty / N;
  }

  return { sample, expectedUnits, indexOf, themeProducts };
}
