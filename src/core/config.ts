export type SlottingStrategy = 'random' | 'category' | 'balanced' | 'spread';
export type ReleasePolicy = 'fifo' | 'trip-wave' | 'balance';
export type BoxingStrategy = 'zone-fill' | 'station-aware';
export type Theme = 'none' | 'taco' | 'grill' | 'party';

export const SLOTTING_STRATEGIES: readonly SlottingStrategy[] = ['random', 'category', 'balanced', 'spread'];
export const RELEASE_POLICIES: readonly ReleasePolicy[] = ['fifo', 'trip-wave', 'balance'];
export const BOXING_STRATEGIES: readonly BoxingStrategy[] = ['zone-fill', 'station-aware'];
export const THEMES: readonly Theme[] = ['none', 'taco', 'grill', 'party'];

export interface SimConfig {
  seed: number;

  // --- Layout (changing these needs a restart) ---
  /** Number of packing stations along the loop. */
  stations: number;
  /** Boxes a station's in-lane can hold, including the one being packed. */
  cacheSize: number;
  /** Loop cells between two neighbouring station diverts. */
  stationSpacing: number;
  /** Length of one conveyor cell (box + gap) in metres. */
  cellLength: number;
  /** Conveyor speed in m/s. One sim tick moves every box one cell. */
  conveyorSpeed: number;
  /** How products are assigned to stations. */
  slotting: SlottingStrategy;

  // --- Operations (live-tunable) ---
  /** Mean seconds to pick, (scan) and place one unit. */
  unitTime: number;
  /** Coefficient of variation of unit time. */
  unitTimeCv: number;
  /** Fixed seconds per box visit (box arrives, worker reads the screen, pushes it out). */
  boxHandlingTime: number;
  /** Minimum seconds between two boxes inducted onto the loop. */
  inductInterval: number;
  /** Max boxes in the system (loop + station lanes). */
  wipCap: number;
  /** How the next box to induct is chosen. */
  release: ReleasePolicy;
  /** How an order is split into boxes. */
  boxing: BoxingStrategy;

  // --- Demand ---
  /** Orders arriving per hour (Poisson). */
  orderRate: number;
  /** Orders already waiting at t=0. */
  initialBacklog: number;
  /** Mean order value in NOK. */
  avgOrderValue: number;
  /** Usable volume of one box in litres. */
  boxVolume: number;
  /** Max weight of one box in kg. */
  boxMaxKg: number;
  /** Themed demand surge, e.g. fredagstaco. */
  theme: Theme;
  /** Share of orders that include the theme bundle while a theme is active. */
  themeShare: number;

  // --- Delivery ---
  /** Number of delivery areas (one truck trip at a time each). */
  routes: number;
  /** Orders per truck trip. */
  tripOrders: number;
  /** A partially filled trip closes after this many seconds. */
  tripMaxWait: number;
  /** Seconds from loop exit to the dock. */
  outboundTravel: number;
  /** Dock doors shown in the viewer. */
  dockDoors: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  seed: 1,
  stations: 26,
  cacheSize: 4,
  stationSpacing: 3,
  cellLength: 0.8,
  conveyorSpeed: 0.5,
  slotting: 'balanced',
  unitTime: 4.5,
  unitTimeCv: 0.4,
  boxHandlingTime: 4,
  inductInterval: 1.6,
  wipCap: 180,
  release: 'trip-wave',
  boxing: 'zone-fill',
  orderRate: 440,
  initialBacklog: 300,
  avgOrderValue: 1250,
  boxVolume: 26,
  boxMaxKg: 14,
  theme: 'none',
  themeShare: 0.45,
  routes: 12,
  tripOrders: 24,
  tripMaxWait: 900,
  outboundTravel: 25,
  dockDoors: 8,
};

/** Keys that only take effect on restart. */
export const RESTART_KEYS: readonly (keyof SimConfig)[] = [
  'seed', 'stations', 'cacheSize', 'stationSpacing', 'cellLength', 'conveyorSpeed', 'slotting',
];

export const ROUTE_NAMES = [
  'Nydalen', 'Grünerløkka', 'Frogner', 'Majorstuen', 'Sagene', 'Gamle Oslo', 'Nordstrand',
  'Grorud', 'Bjerke', 'Ullern', 'Bærum', 'Lillestrøm', 'Ski', 'Asker', 'Lørenskog', 'Tøyen',
];
