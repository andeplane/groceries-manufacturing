export type Zone = 'ambient' | 'chilled' | 'frozen';
export const ZONES: readonly Zone[] = ['ambient', 'chilled', 'frozen'];

export type Shape =
  | 'box' | 'carton' | 'bottle' | 'jug' | 'can' | 'jar' | 'tub' | 'tray' | 'pouch' | 'bag'
  | 'loaf' | 'produce' | 'bunch' | 'tube' | 'roll' | 'multipack' | 'eggs' | 'pot' | 'flat' | 'other';

export const SHAPES: readonly Shape[] = [
  'box', 'carton', 'bottle', 'jug', 'can', 'jar', 'tub', 'tray', 'pouch', 'bag',
  'loaf', 'produce', 'bunch', 'tube', 'roll', 'multipack', 'eggs', 'pot', 'flat', 'other',
];

/** One product as shipped in public/products.json (built by scripts/build_catalog.py). */
export interface Product {
  id: number;
  name: string;
  /** Price in NOK. */
  price: number;
  /** Top-level category, e.g. "Meieri, ost og egg". */
  cat: string;
  /** Second-level category, e.g. "Melk". */
  sub: string;
  zone: Zone;
  shape: Shape;
  /** Outer dimensions in centimetres (w = facing width, h = height, d = depth). */
  w: number;
  h: number;
  d: number;
  kg: number;
  /** Optional texture tile: [atlasIndex, u0, v0, u1, v1] (v from top). */
  tile?: [number, number, number, number, number];
}

export interface Catalog {
  products: Product[];
  byId: Map<number, Product>;
}

export function makeCatalog(products: Product[]): Catalog {
  return { products, byId: new Map(products.map((p) => [p.id, p])) };
}

/** Volume in litres including some packing slack. */
export function productVolumeL(p: Product): number {
  return (p.w * p.h * p.d) / 1000;
}
