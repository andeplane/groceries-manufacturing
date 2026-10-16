# groceries-manufacturing

A simulation of an Oda-style grocery packing loop. Orders come in, are split into boxes, the boxes
ride a circulating conveyor past 26 packing stations, divert into a station's cache lane when they
need products from it, get packed by a person, merge back, and leave for the dock where a truck for
their delivery area waits for its last box.

- **Headless core** (`src/core`) — pure TypeScript, no DOM. Simulates a full shift in well under a
  second (~30,000× real time), so strategies can be swept from Node.
- **3D factory viewer** (`index.html`, `src/viewer`) — three.js rendering of the same core in real
  time: conveyor loop, station lanes and caches, packers, shelves stocked with the real Oda
  assortment, products dropping into boxes, outbound lanes and trucks.
- **3D products** (`src/products3d`, `products.html`) — 35 procedural packaging meshes (can, PET
  bottle, gable carton, pillow bag, tray, …) with each product's photo from oda.com printed on its
  label. Standalone (three.js only) so other projects (oda-store) can reuse it.

## Run

```bash
npm install
npm run dev                # viewer at http://localhost:5173, gallery at /products.html
npm run sim -- --hours 4   # headless run, prints metrics
npm run sweep -- --hours 3 --orderRate 800   # compare slotting × release strategies (± taco surge)
npm test
```

Any config key works as a CLI flag (`--cacheSize 6 --slotting spread --theme taco …`).
Camera: scroll zooms to the cursor, WASD flies, Q/E or Space go down/up, arrow keys turn, Shift is faster, M toggles walk mode (drag to look, Esc to leave).
Viewer URL options: `?warm=1800` (pre-run that many seconds), `?view=station|loop|dock`, `?speed=10`.

## Model

| Piece | How it works |
|---|---|
| Conveyor | Cellular: the loop is a ring of cells (0.8 m: box + gap) that rotates one cell per tick (1.6 s at 0.5 m/s). Station in/out lanes are cell queues. |
| Stations | Each station is a side track running parallel to the loop. A box transfers sideways onto it if its first cell is free (else it recirculates a full lap), queues up to the pack position (`cacheSize` cells), then moves on to the out-lane (`outLaneSize` cells) and transfers back onto the loop further downstream when an empty slot passes. |
| Packing | Per unit: Gaussian pick+scan+place time (mean 4.5 s, σ 35 %, floor 2 s — the human limit), repeat units of the same product take half; plus 4 s per box visit. |
| Demand | Orders ~1,250 NOK (lognormal). Baskets come from a Markov chain over categories built from meal clusters (breakfast, dinner, snacks, household, baking, grill) and Zipf popularity within each shelf. Themes (fredagstaco, grill, party) add bundles to a share of orders. |
| Box planning | Boxes never mix ambient/chilled/frozen; volume/weight capped. `zone-fill` = fewest boxes, `station-aware` = fewest station stops. |
| Slotting | Stations split by zone in proportion to demand. `random`, `category` (whole shelves together), `balanced` (greedy load balancing), `spread` (balanced + spread each sub-category across stations). |
| Release | `fifo` (as orders arrive), `trip-wave` (a truck's boxes released together), `balance` (pick the next box whose stations are least loaded). |
| Trucks | Orders are grouped per delivery area into trips; a truck leaves when its last box reaches the dock. *Dock wait* = first to last box. |

### UPH

Oda's published UPH (~300) counts all productive warehouse hours (receiving, restocking, packing,
loading). The viewer and CLI therefore report:

- **UPH per packer** — units per packer-hour at the stations (~460; Oda Systems cites 500+ picks per operator-hour),
- **Warehouse UPH** — the same units divided by packer hours plus support hours (`supportStaffRatio`, default 0.5 → ~310),
- **Line output** — total units/hour out of the loop.

## Data

`public/products.json` is built by `scripts/build_catalog.py` from the oda-store catalog (5,185
products) plus `data/classification.jsonl` (packaging type, temperature and size class per product,
one OpenAI Decisions API call each; types in `data/geometries.json`). Dimensions come from the pack
contents ("400 g", "1,5 l") × a per-type packaging density, shaped by the type's aspect ratio.
Product photos are the oda-store texture atlases.
