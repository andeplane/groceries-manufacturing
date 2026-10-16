#!/usr/bin/env python3
"""Build public/products.json (+ JPEG texture atlases) from the oda-store catalog.

Usage: python3 scripts/build_catalog.py [path/to/oda-store]

Geometry (shape + dimensions) comes from data/classification.jsonl when present
(one JSON object per product: id, shape, w, h, d, temp, kg). Products without a
classification get a neutral placeholder: a box sized from the pack weight/volume.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '..', 'oda-store')

CHILLED_CATS = {'Meieri, ost og egg', 'Kylling og kjøtt', 'Fisk og sjømat', 'Pålegg', 'Ferskvaredisken', 'Mathall'}
CHILLED_SUBS = {'Salat', 'Ferske urter', 'Bær', 'Ferdigretter', 'Fersk pasta', 'Juice og smoothie', 'Pølser'}


def parse_amount(extra: str):
    """Return (litres_estimate, kg_estimate) from strings like '400 g', '1,5 l', '6 x 0,33 l'."""
    s = extra.lower().replace(',', '.')
    mult = 1.0
    m = re.search(r'(\d+)\s*x\s*', s)
    if m:
        mult = float(m.group(1))
    m = re.search(r'(\d+(?:\.\d+)?)\s*(kg|g|l|dl|cl|ml)\b', s)
    if not m:
        return None, None
    v, u = float(m.group(1)), m.group(2)
    litres = {'kg': v, 'g': v / 1000, 'l': v, 'dl': v / 10, 'cl': v / 100, 'ml': v / 1000}[u] * mult
    return litres, litres


def placeholder_dims(litres):
    if litres is None:
        litres = 0.6
    vol_cm3 = max(80.0, min(12000.0, litres * 1000 * 1.35))
    # 2:3:1 proportions (w:h:d)
    k = (vol_cm3 / 6.0) ** (1 / 3)
    return round(2 * k, 1), round(3 * k, 1), round(1 * k, 1)


def main():
    cat = json.load(open(os.path.join(STORE, 'public', 'catalog.json')))['products']
    tiles = json.load(open(os.path.join(STORE, 'public', 'atlas-index.json')))['tiles']
    cls_path = os.path.join(ROOT, 'data', 'classification.jsonl')
    cls = {}
    if os.path.exists(cls_path):
        for line in open(cls_path):
            line = line.strip()
            if line:
                o = json.loads(line)
                cls[int(o['id'])] = o
    out = []
    for p in cat:
        path = p['paths'][0] if p['paths'] else ['Annet']
        top = path[0]
        sub = path[1] if len(path) > 1 else top
        litres, kg = parse_amount(p.get('extra') or '')
        if 'Frysevare' in p['classifiers']:
            zone = 'frozen'
        elif top in CHILLED_CATS or sub in CHILLED_SUBS or any(c.startswith('Holdbarhetsgaranti') for c in p['classifiers']):
            zone = 'chilled'
        else:
            zone = 'ambient'
        c = cls.get(p['id'])
        if c:
            shape, w, h, d = c['shape'], float(c['w']), float(c['h']), float(c['d'])
            zone = c.get('temp', zone)
            kg = float(c.get('kg', kg or 0.5))
        else:
            shape = 'box'
            w, h, d = placeholder_dims(litres)
        try:
            price = float(p['price'])
        except (TypeError, ValueError):
            price = 50.0
        rec = {
            'id': p['id'], 'name': p['name'], 'price': round(price, 2), 'cat': top, 'sub': sub,
            'zone': zone, 'shape': shape, 'w': w, 'h': h, 'd': d, 'kg': round(kg or 0.5, 3),
        }
        t = tiles.get(str(p['id']))
        if t:
            rec['tile'] = [t['atlas']] + [round(x, 5) for x in t['uv']]
        out.append(rec)
    os.makedirs(os.path.join(ROOT, 'public'), exist_ok=True)
    with open(os.path.join(ROOT, 'public', 'products.json'), 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'products: {len(out)}  classified: {sum(1 for p in out if p["id"] in cls)}')

    # Texture atlases: PNG -> JPEG (much smaller, alpha not needed on box faces)
    from PIL import Image
    atlas_dir = os.path.join(STORE, 'public', 'atlas')
    dst = os.path.join(ROOT, 'public', 'atlas')
    os.makedirs(dst, exist_ok=True)
    for name in sorted(os.listdir(atlas_dir)):
        if name.startswith('base-') and name.endswith('.png'):
            im = Image.open(os.path.join(atlas_dir, name))
            bg = Image.new('RGB', im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[-1] if im.mode == 'RGBA' else None)
            bg.save(os.path.join(dst, name.replace('.png', '.jpg')), quality=82, optimize=True)
    print('atlases:', sorted(os.listdir(dst)))


if __name__ == '__main__':
    main()
