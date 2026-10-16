export type Zone = 'ambient' | 'chilled' | 'frozen';
export const ZONES: readonly Zone[] = ['ambient', 'chilled', 'frozen'];

/** Packaging geometry types (data/geometries.json), assigned per product by the OpenAI Decisions API. */
export type Shape =
  | 'can'
  | 'pet_bottle'
  | 'glass_bottle'
  | 'jug'
  | 'squeeze_bottle'
  | 'pump_bottle'
  | 'aerosol'
  | 'gable_carton'
  | 'brick_carton'
  | 'box'
  | 'jar'
  | 'tub'
  | 'tray'
  | 'vacuum_pack'
  | 'block'
  | 'bar'
  | 'pillow_bag'
  | 'standup_pouch'
  | 'paper_sack'
  | 'sachet'
  | 'tube'
  | 'loaf'
  | 'produce_round'
  | 'produce_long'
  | 'net_bag'
  | 'clamshell'
  | 'egg_carton'
  | 'multipack'
  | 'roll_pack'
  | 'soft_pack'
  | 'flat_pack'
  | 'blister_card'
  | 'potted_plant'
  | 'bouquet'
  | 'irregular';

export const SHAPES: readonly Shape[] = ['can', 'pet_bottle', 'glass_bottle', 'jug', 'squeeze_bottle', 'pump_bottle', 'aerosol', 'gable_carton', 'brick_carton', 'box', 'jar', 'tub', 'tray', 'vacuum_pack', 'block', 'bar', 'pillow_bag', 'standup_pouch', 'paper_sack', 'sachet', 'tube', 'loaf', 'produce_round', 'produce_long', 'net_bag', 'clamshell', 'egg_carton', 'multipack', 'roll_pack', 'soft_pack', 'flat_pack', 'blister_card', 'potted_plant', 'bouquet', 'irregular'];

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
  /** Mean package colour (sRGB hex) from the product photo. */
  col?: string;
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
