#!/usr/bin/env python3
"""Build public/products.json (+ JPEG texture atlases) from the oda-store catalog.

Usage: python3 scripts/build_catalog.py [path/to/oda-store]

Geometry comes from data/classification.jsonl (OpenAI Decisions API, one call per product:
shape type from data/geometries.json, temperature, size class). Dimensions are derived from the
pack contents ("400 g", "1,5 l") times a per-type packaging density, shaped by the type's aspect.
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


# cm^3 of packed product per gram/ml of contents, per geometry type (packaging + air).
DENSITY = {
    'can': 1.15, 'pet_bottle': 1.15, 'glass_bottle': 1.7, 'jug': 1.1, 'squeeze_bottle': 1.3, 'pump_bottle': 1.45,
    'aerosol': 1.7, 'gable_carton': 1.05, 'brick_carton': 1.05, 'box': 2.4, 'jar': 1.6, 'tub': 1.3, 'tray': 1.8,
    'vacuum_pack': 1.3, 'block': 1.1, 'bar': 1.4, 'pillow_bag': 5.0, 'standup_pouch': 2.2, 'paper_sack': 1.6,
    'sachet': 2.2, 'tube': 1.4, 'loaf': 3.5, 'produce_round': 1.15, 'produce_long': 1.3, 'net_bag': 1.6,
    'clamshell': 2.2, 'egg_carton': 2.6, 'multipack': 1.25, 'roll_pack': 9.0, 'soft_pack': 3.0, 'flat_pack': 2.0,
    'blister_card': 4.0, 'potted_plant': 3.0, 'bouquet': 4.0, 'irregular': 2.0,
}
SIZE_VOLUME = {'tiny': 45, 'small': 350, 'medium': 1100, 'large': 3600, 'very_large': 12000}


def dims_for(shape, aspect, size, litres):
    """Outer w, h, d in cm from pack contents, geometry density and the type's aspect ratio."""
    base = SIZE_VOLUME.get(size, 1000)
    if litres:
        vol = litres * 1000 * DENSITY.get(shape, 2.0)
        vol = max(base / 4, min(base * 4, vol))
    else:
        vol = base
    a, b, c = aspect
    k = (vol / (a * b * c)) ** (1 / 3)
    return round(a * k, 1), round(b * k, 1), round(c * k, 1)


def placeholder_dims(litres):
    return dims_for('box', [2, 3, 1], 'medium', litres)


def tile_colour(atlases, t):
    """Mean colour of the non-background pixels of a product photo (sRGB hex)."""
    im = atlases[t['atlas']]
    W, H = im.size
    u0, v0, u1, v1 = t['uv']
    crop = im.crop((int(u0 * W), int(v0 * H), max(int(u0 * W) + 1, int(u1 * W)), max(int(v0 * H) + 1, int(v1 * H)))).convert('RGB').resize((24, 24))
    px = [p for p in crop.getdata() if min(p) < 225 and max(p) > 25]
    if not px:
        return '#d8d8d8'
    # weight saturated pixels more so the colour reads as the package colour, not its shading
    tot = [0.0, 0.0, 0.0]
    wsum = 0.0
    for r, g, b in px:
        w = 0.25 + (max(r, g, b) - min(r, g, b)) / 255
        tot[0] += r * w; tot[1] += g * w; tot[2] += b * w; wsum += w
    r, g, b = (int(x / wsum) for x in tot)
    return f'#{r:02x}{g:02x}{b:02x}'


def main():
    cat = json.load(open(os.path.join(STORE, 'public', 'catalog.json')))['products']
    tiles = json.load(open(os.path.join(STORE, 'public', 'atlas-index.json')))['tiles']
    from PIL import Image
    atlases = {}
    atlas_dir = os.path.join(STORE, 'public', 'atlas')
    for name in os.listdir(atlas_dir):
        if name.startswith('base-') and name.endswith('.png'):
            atlases[int(name[5:-4])] = Image.open(os.path.join(atlas_dir, name)).convert('RGB')
    geos = json.load(open(os.path.join(ROOT, 'data', 'geometries.json')))['types']
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
        if c and c['shape'] in geos:
            shape = c['shape']
            w, h, d = dims_for(shape, geos[shape]['aspect'], c.get('size'), litres)
            # Frysevare is authoritative; otherwise trust a confident classifier temperature.
            if zone != 'frozen' and c.get('temp_conf', 0) >= 0.8:
                zone = c['temp']
            if not kg:
                kg = SIZE_VOLUME.get(c.get('size'), 1000) / 2000
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
            rec['col'] = tile_colour(atlases, t)
        out.append(rec)
    os.makedirs(os.path.join(ROOT, 'public'), exist_ok=True)
    with open(os.path.join(ROOT, 'public', 'products.json'), 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f'products: {len(out)}  classified: {sum(1 for p in out if p["id"] in cls)}')

    # Texture atlases: PNG -> JPEG (much smaller, alpha not needed on box faces)
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
