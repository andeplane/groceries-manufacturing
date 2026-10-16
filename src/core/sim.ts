import { Rng } from './rng';
import { makeCatalog, type Catalog, type Product, type Zone } from './catalog';
import { DEFAULT_CONFIG, isRobotStation, type SimConfig } from './config';
import { buildDemandModel, type DemandModel, type Order } from './demand';
import { buildSlotting, type Slotting } from './slotting';
import { planBoxes, type BoxItem } from './planner';
import { buildLayout, type Layout } from './layout';

export enum Loc {
  /** Planned, waiting for the box erector. */
  Pending = 0,
  Loop = 1,
  InLane = 2,
  OutLane = 3,
  /** On the outbound conveyor towards the dock. */
  Outbound = 4,
  Dock = 5,
  Shipped = 6,
}

export interface PlacedUnit {
  productId: number;
  station: number;
  /** Sim time the unit lands in the box. */
  t: number;
}

export interface Box {
  id: number;
  orderId: number;
  tripId: number;
  zone: Zone;
  units: number;
  items: BoxItem[];
  /** Stations still to visit. */
  remaining: number[];
  loc: Loc;
  /** Station index while in a lane, else -1. */
  station: number;
  /** Loop slot (Loc.Loop) or lane cell (Loc.InLane / Loc.OutLane). */
  cell: number;
  queued: boolean;
  createdAt: number;
  inductedAt: number;
  exitedAt: number;
  dockAt: number;
  laps: number;
  missedDiverts: number;
  placed: PlacedUnit[];
}

export interface StationState {
  index: number;
  zone: Zone;
  inLane: (Box | null)[];
  outLane: (Box | null)[];
  /** Box at the pack position currently being (or done being) packed. */
  packing: Box | null;
  packStart: number;
  packEnd: number;
  busyTime: number;
  blockedTime: number;
  units: number;
  boxes: number;
  /** Units of in-system boxes still to be packed here. */
  pendingUnits: number;
}

export interface Trip {
  id: number;
  route: number;
  orders: number[];
  boxes: Box[];
  openedAt: number;
  closedAt: number;
  boxesAtDock: number;
  firstDockAt: number;
  lastDockAt: number;
  departedAt: number;
  door: number;
}

export type SimEvent =
  | { type: 'pack'; t: number; station: number; box: Box; units: PlacedUnit[]; end: number }
  | { type: 'depart'; t: number; trip: Trip }
  | { type: 'order'; t: number; order: Order };

export interface SimStats {
  t: number;
  measuredSeconds: number;
  unitsPacked: number;
  /** Units per hour out of the whole line. */
  lineUph: number;
  /** Line UPH over the last 10 simulated minutes. */
  lineUphRecent: number;
  /** Units per packer-hour over the stations packed by people (0 when every station is a robot). */
  uphPerPacker: number;
  uphPerPackerRecent: number;
  /** Units per robot-hour over the stations packed by robot arms (0 when there are none). */
  uphPerRobot: number;
  uphPerRobotRecent: number;
  /** Stations packed by people / by robot arms (under the current `packers` setting). */
  humanStations: number;
  robotStations: number;
  /**
   * Units per productive warehouse hour: packer hours plus support hours (`supportStaffRatio` per station,
   * since restocking and loading scale with stations, not with who packs) — comparable to online grocers'
   * published UPH. Robots add no human hours.
   */
  uphWarehouse: number;
  uphWarehouseRecent: number;
  ordersArrived: number;
  ordersShipped: number;
  boxesInducted: number;
  boxesExited: number;
  boxesInSystem: number;
  boxesWaiting: number;
  unitsPerBox: number;
  stopsPerBox: number;
  lapsPerBox: number;
  missedDivertsPerBox: number;
  boxCycleMean: number;
  boxCycleP95: number;
  tripsDeparted: number;
  /** Time between the first and last box of a trip reaching the dock. */
  dockWaitMean: number;
  dockWaitP95: number;
  dockWaitMax: number;
  /** Trip close → truck departure. */
  tripLeadMean: number;
  utilization: number[];
  blocked: number[];
  stationUnits: number[];
  loopOccupancy: number;
}

interface Measure {
  since: number;
  units: number;
  boxesExited: number;
  stops: number;
  laps: number;
  missed: number;
  boxUnits: number;
  cycle: number[];
  dockWait: number[];
  tripLead: number[];
  ordersShipped: number;
  busy: Float64Array;
  blocked: Float64Array;
  stationUnits: Float64Array;
  loopOccSum: number;
  loopOccN: number;
}

export interface SimInit {
  products: Product[];
  config?: Partial<SimConfig>;
  /** Collect events (the viewer uses them; headless runs leave this off for speed). */
  events?: boolean;
}

export class Simulation {
  readonly cfg: SimConfig;
  readonly catalog: Catalog;
  readonly demand: DemandModel;
  readonly slotting: Slotting;
  readonly layout: Layout;
  readonly dt: number;

  t = 0;
  tick = 0;
  readonly loop: (Box | null)[];
  readonly stations: StationState[];
  readonly boxes = new Map<number, Box>();
  readonly trips = new Map<number, Trip>();
  readonly releaseQueue: Box[] = [];
  readonly outbound: Box[] = [];
  readonly events: SimEvent[] = [];

  private rng: Rng;
  private orderSeq = 0;
  private boxSeq = 0;
  private tripSeq = 0;
  private nextOrderAt: number;
  private lastInductAt = -Infinity;
  private openTrip: (Trip | null)[];
  private ordersArrived = 0;
  private boxesInducted = 0;
  private boxesExited = 0;
  private tripsDeparted = 0;
  private stationAtDivert: Int32Array;
  private stationAtMerge: Int32Array;
  private recordEvents: boolean;
  private recent: { t: number; units: number; station: number }[] = [];
  private m!: Measure;
  private doorTrips: number[];

  constructor(init: SimInit) {
    this.cfg = { ...DEFAULT_CONFIG, ...init.config };
    this.recordEvents = !!init.events;
    this.catalog = makeCatalog(init.products);
    this.rng = new Rng(this.cfg.seed);
    this.demand = buildDemandModel(this.catalog, { avgOrderValue: this.cfg.avgOrderValue });
    this.slotting = buildSlotting(this.catalog, this.demand.expectedUnits, this.cfg.stations, this.cfg.slotting, this.cfg.seed);
    this.layout = buildLayout(this.cfg);
    this.dt = this.cfg.cellLength / this.cfg.conveyorSpeed;
    this.loop = new Array(this.layout.cells).fill(null);
    this.stations = this.layout.stations.map((g) => ({
      index: g.index,
      zone: this.slotting.stationZone[g.index],
      inLane: new Array(this.cfg.cacheSize).fill(null),
      outLane: new Array(this.cfg.outLaneSize).fill(null),
      packing: null,
      packStart: 0,
      packEnd: 0,
      busyTime: 0,
      blockedTime: 0,
      units: 0,
      boxes: 0,
      pendingUnits: 0,
    }));
    this.stationAtDivert = new Int32Array(this.layout.cells).fill(-1);
    this.stationAtMerge = new Int32Array(this.layout.cells).fill(-1);
    for (const g of this.layout.stations) {
      this.stationAtDivert[g.divertCell % this.layout.cells] = g.index;
      this.stationAtMerge[g.mergeCell % this.layout.cells] = g.index;
    }
    this.openTrip = new Array(this.cfg.routes).fill(null);
    this.doorTrips = new Array(this.cfg.dockDoors).fill(0);
    this.resetMeasurement();
    for (let i = 0; i < this.cfg.initialBacklog; i++) this.arriveOrder(0);
    this.nextOrderAt = this.rng.exponential(3600 / Math.max(1, this.cfg.orderRate));
  }

  /** Change live-tunable parameters. */
  set(patch: Partial<SimConfig>): void {
    const prevRelease = this.cfg.release;
    Object.assign(this.cfg, patch);
    if (patch.release && patch.release !== prevRelease && patch.release === 'fifo') {
      for (const trip of this.openTrip) if (trip) for (const b of trip.boxes) this.enqueue(b);
    }
    if (patch.orderRate !== undefined) {
      this.nextOrderAt = this.t + this.rng.exponential(3600 / Math.max(1, this.cfg.orderRate));
    }
  }

  /** Physical loop position → slot index. */
  slotAt(cell: number): number {
    const n = this.layout.cells;
    return (((cell - this.tick) % n) + n) % n;
  }

  /** Slot index → physical loop cell. */
  cellOfSlot(slot: number): number {
    return (slot + this.tick) % this.layout.cells;
  }

  resetMeasurement(): void {
    const n = this.cfg.stations;
    this.m = {
      since: this.t,
      units: 0,
      boxesExited: 0,
      stops: 0,
      laps: 0,
      missed: 0,
      boxUnits: 0,
      cycle: [],
      dockWait: [],
      tripLead: [],
      ordersShipped: 0,
      busy: new Float64Array(n),
      blocked: new Float64Array(n),
      stationUnits: new Float64Array(n),
      loopOccSum: 0,
      loopOccN: 0,
    };
  }

  /** Advance one conveyor tick (every box moves at most one cell). */
  step(): void {
    this.tick++;
    this.t += this.dt;
    const t = this.t;
    const cfg = this.cfg;

    // Order arrivals.
    while (this.nextOrderAt <= t) {
      this.arriveOrder(this.nextOrderAt);
      this.nextOrderAt += this.rng.exponential(3600 / Math.max(1, cfg.orderRate));
    }
    // Trips that waited long enough close partially filled.
    for (const trip of this.openTrip) {
      if (trip && t - trip.openedAt >= cfg.tripMaxWait) this.closeTrip(trip);
    }

    // Stations: move boxes out first so space frees up for incoming boxes.
    const C = cfg.cacheSize;
    const O = cfg.outLaneSize;
    for (const st of this.stations) {
      const g = this.layout.stations[st.index];
      // a) merge out-lane head back onto the loop
      const head = st.outLane[0];
      if (head) {
        const slot = this.slotAt(g.mergeCell);
        if (!this.loop[slot]) {
          this.loop[slot] = head;
          st.outLane[0] = null;
          head.loc = Loc.Loop;
          head.cell = slot;
          head.station = -1;
        }
      }
      // b) advance out-lane towards the loop
      for (let j = 1; j < O; j++) {
        const b = st.outLane[j];
        if (b && !st.outLane[j - 1]) {
          st.outLane[j - 1] = b;
          st.outLane[j] = null;
          b.cell = j - 1;
        }
      }
      // c) finished box at the pack position moves to the out-lane
      const pk = st.packing;
      if (pk && t >= st.packEnd && !st.outLane[O - 1]) {
        st.inLane[C - 1] = null;
        st.outLane[O - 1] = pk;
        pk.loc = Loc.OutLane;
        pk.cell = O - 1;
        st.packing = null;
        // Waiting longer than one conveyor tick for the out-lane counts as blocked.
        const blocked = Math.max(0, t - st.packEnd - this.dt);
        st.blockedTime += blocked;
        if (st.packEnd >= this.m.since) this.m.blocked[st.index] += blocked;
      }
      // d) advance in-lane towards the pack position
      for (let i = C - 2; i >= 0; i--) {
        const b = st.inLane[i];
        if (b && !st.inLane[i + 1]) {
          st.inLane[i + 1] = b;
          st.inLane[i] = null;
          b.cell = i + 1;
        }
      }
      // e) start packing a newly arrived box
      const at = st.inLane[C - 1];
      if (at && !st.packing) this.startPacking(st, at);
      // f) divert a passing box that needs this station
      const slot = this.slotAt(g.divertCell);
      const passing = this.loop[slot];
      if (passing && passing.remaining.includes(st.index)) {
        if (!st.inLane[0]) {
          this.loop[slot] = null;
          st.inLane[0] = passing;
          passing.loc = Loc.InLane;
          passing.station = st.index;
          passing.cell = 0;
          if (C === 1 && !st.packing) this.startPacking(st, passing);
        } else {
          passing.missedDiverts++;
        }
      }
    }

    // Exit: completed boxes leave the loop towards the dock.
    {
      const slot = this.slotAt(this.layout.exitCell);
      const b = this.loop[slot];
      if (b && b.remaining.length === 0) {
        this.loop[slot] = null;
        b.loc = Loc.Outbound;
        b.exitedAt = t;
        b.dockAt = t + cfg.outboundTravel;
        this.outbound.push(b);
        this.boxesExited++;
        this.m.boxesExited++;
        this.m.cycle.push(t - b.inductedAt);
        this.m.laps += b.laps;
        this.m.missed += b.missedDiverts;
        this.m.boxUnits += b.units;
        this.m.stops += new Set(b.placed.map((p) => p.station)).size;
      }
    }

    // Induction + lap counting at the induct point.
    {
      const slot = this.slotAt(this.layout.inductCell);
      const b = this.loop[slot];
      if (b) {
        b.laps++;
      } else if (this.releaseQueue.length && t - this.lastInductAt >= cfg.inductInterval - 1e-6 && this.inSystem() < cfg.wipCap) {
        const nb = this.pickRelease();
        if (nb) {
          this.loop[slot] = nb;
          nb.loc = Loc.Loop;
          nb.cell = slot;
          nb.inductedAt = t;
          this.lastInductAt = t;
          this.boxesInducted++;
          for (const it of nb.items) this.stations[it.station].pendingUnits += it.qty;
        }
      }
    }

    // Outbound conveyor → dock → trucks.
    if (this.outbound.length) {
      let w = 0;
      for (const b of this.outbound) {
        if (b.dockAt <= t) this.arriveDock(b);
        else this.outbound[w++] = b;
      }
      this.outbound.length = w;
    }

    // Loop occupancy sample.
    let occ = 0;
    for (const b of this.loop) if (b) occ++;
    this.m.loopOccSum += occ / this.loop.length;
    this.m.loopOccN++;
  }

  /** Run headless for `seconds` of simulated time. */
  run(seconds: number): void {
    const end = this.t + seconds;
    while (this.t < end) this.step();
  }

  inSystem(): number {
    return this.boxesInducted - this.boxesExited;
  }

  private startPacking(st: StationState, box: Box): void {
    const cfg = this.cfg;
    st.packing = box;
    st.packStart = this.t;
    let tt = this.t + cfg.boxHandlingTime * 0.4;
    const robot = isRobotStation(cfg, st.index);
    const units: PlacedUnit[] = [];
    for (const it of box.items) {
      if (it.station !== st.index) continue;
      for (let q = 0; q < it.qty; q++) {
        const base = robot
          ? this.rng.truncNormal(cfg.robotUnitTime, cfg.robotUnitTime * cfg.robotUnitTimeCv, cfg.robotUnitTimeMin)
          : this.rng.truncNormal(cfg.unitTime, cfg.unitTime * cfg.unitTimeCv, cfg.unitTimeMin);
        tt += q === 0 ? base : base * 0.5; // same product again is quicker
        units.push({ productId: it.productId, station: st.index, t: tt });
      }
    }
    st.packEnd = tt + cfg.boxHandlingTime * 0.6;
    box.placed.push(...units);
    box.remaining = box.remaining.filter((s) => s !== st.index);
    st.units += units.length;
    st.boxes++;
    st.pendingUnits -= units.length;
    st.busyTime += st.packEnd - st.packStart;
    this.m.busy[st.index] += st.packEnd - st.packStart;
    this.m.units += units.length;
    this.m.stationUnits[st.index] += units.length;
    this.recent.push({ t: st.packEnd, units: units.length, station: st.index });
    if (this.recordEvents) this.events.push({ type: 'pack', t: this.t, station: st.index, box, units, end: st.packEnd });
  }

  private pickRelease(): Box | null {
    const q = this.releaseQueue;
    if (this.cfg.release !== 'balance' || q.length < 2) return q.shift() ?? null;
    // Pick, among the next few boxes, the one whose busiest station is least loaded right now.
    const window = Math.min(q.length, 40);
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < window; i++) {
      const b = q[i];
      let score = 0;
      for (const s of b.remaining) {
        const st = this.stations[s];
        let lane = 0;
        for (const x of st.inLane) if (x) lane++;
        score = Math.max(score, st.pendingUnits + lane * 6);
      }
      score += i * 0.6; // keep roughly in order so trips still finish together
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return q.splice(best, 1)[0];
  }

  private enqueue(b: Box): void {
    if (b.queued) return;
    b.queued = true;
    this.releaseQueue.push(b);
  }

  private arriveOrder(t: number): void {
    const cfg = this.cfg;
    const route = this.rng.int(cfg.routes);
    const theme = cfg.theme !== 'none' && this.rng.next() < cfg.themeShare ? cfg.theme : null;
    const order = this.demand.sample(this.rng, this.orderSeq++, t, route, theme);
    this.ordersArrived++;
    let trip = this.openTrip[route];
    if (!trip) {
      trip = {
        id: this.tripSeq++,
        route,
        orders: [],
        boxes: [],
        openedAt: t,
        closedAt: -1,
        boxesAtDock: 0,
        firstDockAt: -1,
        lastDockAt: -1,
        departedAt: -1,
        door: this.assignDoor(),
      };
      this.trips.set(trip.id, trip);
      this.openTrip[route] = trip;
    }
    trip.orders.push(order.id);
    const plans = planBoxes(order, this.catalog, this.slotting, cfg.boxing, cfg.boxVolume, cfg.boxMaxKg);
    for (const p of plans) {
      const b: Box = {
        id: this.boxSeq++,
        orderId: order.id,
        tripId: trip.id,
        zone: p.zone,
        units: p.units,
        items: p.items,
        remaining: [...p.stations],
        loc: Loc.Pending,
        station: -1,
        cell: -1,
        queued: false,
        createdAt: t,
        inductedAt: -1,
        exitedAt: -1,
        dockAt: -1,
        laps: 0,
        missedDiverts: 0,
        placed: [],
      };
      this.boxes.set(b.id, b);
      trip.boxes.push(b);
      if (cfg.release === 'fifo') this.enqueue(b);
    }
    if (this.recordEvents) this.events.push({ type: 'order', t, order });
    if (trip.orders.length >= cfg.tripOrders) this.closeTrip(trip);
  }

  private assignDoor(): number {
    let best = 0;
    for (let d = 1; d < this.doorTrips.length; d++) if (this.doorTrips[d] < this.doorTrips[best]) best = d;
    this.doorTrips[best]++;
    return best;
  }

  private closeTrip(trip: Trip): void {
    trip.closedAt = this.t;
    if (this.openTrip[trip.route] === trip) this.openTrip[trip.route] = null;
    for (const b of trip.boxes) this.enqueue(b);
    this.maybeDepart(trip);
  }

  private arriveDock(b: Box): void {
    b.loc = Loc.Dock;
    const trip = this.trips.get(b.tripId)!;
    trip.boxesAtDock++;
    if (trip.firstDockAt < 0) trip.firstDockAt = b.dockAt;
    trip.lastDockAt = b.dockAt;
    this.maybeDepart(trip);
  }

  private maybeDepart(trip: Trip): void {
    if (trip.closedAt < 0 || trip.departedAt >= 0 || trip.boxesAtDock < trip.boxes.length) return;
    trip.departedAt = this.t;
    this.tripsDeparted++;
    this.doorTrips[trip.door]--;
    if (trip.firstDockAt >= this.m.since) {
      this.m.dockWait.push(trip.lastDockAt - trip.firstDockAt);
      this.m.tripLead.push(trip.departedAt - trip.closedAt);
      this.m.ordersShipped += trip.orders.length;
    }
    for (const b of trip.boxes) {
      b.loc = Loc.Shipped;
      this.boxes.delete(b.id);
    }
    this.trips.delete(trip.id);
    if (this.recordEvents) this.events.push({ type: 'depart', t: this.t, trip });
  }

  stats(): SimStats {
    const m = this.m;
    const secs = Math.max(1e-9, this.t - m.since);
    const n = this.cfg.stations;
    // Rolling 10-minute UPH (units counted when their box visit finishes).
    const win = 600;
    while (this.recent.length && this.recent[0].t < this.t - win) this.recent.shift();
    let recentUnits = 0;
    let recentRobotUnits = 0;
    for (const r of this.recent) {
      if (r.t > this.t) continue;
      recentUnits += r.units;
      if (isRobotStation(this.cfg, r.station)) recentRobotUnits += r.units;
    }
    let robots = 0;
    let robotUnits = 0;
    for (let i = 0; i < n; i++) {
      if (!isRobotStation(this.cfg, i)) continue;
      robots++;
      robotUnits += m.stationUnits[i];
    }
    const humans = n - robots;
    const perHour = (units: number, span: number, count: number) => (span > 0 && count > 0 ? (units / span) * 3600 / count : 0);
    const staffHours = humans + n * this.cfg.supportStaffRatio;
    const recentSpan = Math.min(win, this.t);
    const pct = (arr: number[], p: number) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))];
    };
    const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    let waiting = 0;
    for (const b of this.releaseQueue) if (b.loc === Loc.Pending) waiting++;
    return {
      t: this.t,
      measuredSeconds: secs,
      unitsPacked: m.units,
      lineUph: (m.units / secs) * 3600,
      lineUphRecent: recentSpan > 0 ? (recentUnits / recentSpan) * 3600 : 0,
      uphPerPacker: perHour(m.units - robotUnits, secs, humans),
      uphPerPackerRecent: perHour(recentUnits - recentRobotUnits, recentSpan, humans),
      uphPerRobot: perHour(robotUnits, secs, robots),
      uphPerRobotRecent: perHour(recentRobotUnits, recentSpan, robots),
      humanStations: humans,
      robotStations: robots,
      uphWarehouse: perHour(m.units, secs, staffHours),
      uphWarehouseRecent: perHour(recentUnits, recentSpan, staffHours),
      ordersArrived: this.ordersArrived,
      ordersShipped: m.ordersShipped,
      boxesInducted: this.boxesInducted,
      boxesExited: this.boxesExited,
      boxesInSystem: this.inSystem(),
      boxesWaiting: waiting,
      unitsPerBox: m.boxesExited ? m.boxUnits / m.boxesExited : 0,
      stopsPerBox: m.boxesExited ? m.stops / m.boxesExited : 0,
      lapsPerBox: m.boxesExited ? m.laps / m.boxesExited : 0,
      missedDivertsPerBox: m.boxesExited ? m.missed / m.boxesExited : 0,
      boxCycleMean: mean(m.cycle),
      boxCycleP95: pct(m.cycle, 0.95),
      tripsDeparted: this.tripsDeparted,
      dockWaitMean: mean(m.dockWait),
      dockWaitP95: pct(m.dockWait, 0.95),
      dockWaitMax: m.dockWait.length ? Math.max(...m.dockWait) : 0,
      tripLeadMean: mean(m.tripLead),
      utilization: Array.from({ length: n }, (_, i) => Math.min(1, m.busy[i] / secs)),
      blocked: Array.from({ length: n }, (_, i) => Math.min(1, m.blocked[i] / secs)),
      stationUnits: Array.from(m.stationUnits),
      loopOccupancy: m.loopOccN ? m.loopOccSum / m.loopOccN : 0,
    };
  }

  /** Drain collected events (viewer). */
  drainEvents(): SimEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
