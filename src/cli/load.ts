import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Product } from '../core/catalog';

const here = dirname(fileURLToPath(import.meta.url));

export function loadProducts(path = resolve(here, '../../public/products.json')): Product[] {
  return JSON.parse(readFileSync(path, 'utf8')) as Product[];
}
