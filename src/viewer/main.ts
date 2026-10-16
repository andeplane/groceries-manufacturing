import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import GUI from 'lil-gui';
import {
  BOXING_STRATEGIES, DEFAULT_CONFIG, Loc, RELEASE_POLICIES, ROUTE_NAMES, SLOTTING_STRATEGIES, THEMES, Simulation,
  type Box, type Product, type SimConfig,
} from '../core';
import { loadProductAtlas, probeMaxTextureSize } from './textures';
import { World } from './world';
import { ZONE_COLOR } from './factory';
import { drawChart } from './chart';
import { CameraRig } from './camera';
import { TOUR_STEPS, Tour, tourSeen } from './tutorial';

const BASE = import.meta.env.BASE_URL;

async function main() {
  const loading = document.getElementById('loading')!;
  const maxTex = probeMaxTextureSize();
  const [products, atlas] = await Promise.all([
    fetch(`${BASE}products.json`).then((r) => r.json() as Promise<Product[]>),
    loadProductAtlas(BASE, maxTex),
  ]);

  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1d2026);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  scene.fog = new THREE.Fog(0x1d2026, 70, 160);

  scene.add(new THREE.HemisphereLight(0xeef3ff, 0x5b5650, 1.1));
  const sun = new THREE.DirectionalLight(0xfff6ea, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.3, 400);
  const rig = new CameraRig(camera, canvas, () => {
    const b = sim.layout.bounds;
    return { minX: sim.layout.docks[0].door.x + 0.6, maxX: b.maxX + 7.4, minZ: b.minZ - 7.4, maxZ: b.maxZ + 12 };
  }, () => world?.root ?? null);

  const params = {
    speed: 4,
    paused: false,
    ...structuredClone(DEFAULT_CONFIG),
  };

  let sim!: Simulation;
  let world: World | null = null;
  let simClock = 0;
  let utilHist: { t: number; busy: number[] }[] = [];
  let blockedHist: { t: number; blocked: number[] }[] = [];
  let history: { t: number; packer: number; whse: number }[] = [];
  let lastSample = 0;

  const start = () => {
    if (world) {
      scene.remove(world.root);
      world.dispose();
    }
    const cfg: Partial<SimConfig> = {};
    for (const k of Object.keys(DEFAULT_CONFIG) as (keyof SimConfig)[]) (cfg as Record<string, unknown>)[k] = params[k];
    sim = new Simulation({ products, config: cfg, events: false });
    world = new World(sim, atlas.texture, atlas.remap);
    scene.add(world.root);
    simClock = 0;
    utilHist = [];
    blockedHist = [];
    history = [];
    lastSample = 0;
    const b = sim.layout.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    sun.position.set(span * 0.3, 40, span * 0.45);
    sun.target.position.set((b.minX + b.maxX) / 2, 0, 0);
    const sc = sun.shadow.camera;
    sc.left = -span * 0.75;
    sc.right = span * 0.75;
    sc.top = span * 0.75;
    sc.bottom = -span * 0.75;
    sc.near = 1;
    sc.far = 40 + span * 1.5;
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.near = span * 0.9;
      scene.fog.far = span * 2.2;
    }
    sc.updateProjectionMatrix();
    buildBars();
  };

  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  /** Seconds the next camera move takes (0 = jump). */
  let flight = 0;
  const views = {
    overview: () => {
      const b = sim.layout.bounds;
      const span = b.maxX - b.minX;
      const fit = (span * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.aspect;
      const cx = (b.minX + b.maxX) / 2;
      rig.look(V(cx, fit * 0.72, 1 + fit * 0.62), V(cx, 0, 1), flight);
    },
    station: () => {
      const g = sim.layout.stations[3];
      const p = g.inLane[g.inLane.length - 1];
      rig.look(V(p.x + g.tangent.x * 2.2 - g.normal.x * 3.2, 2.6, p.z + g.tangent.z * 2.2 - g.normal.z * 3.2), V(p.x, 1.0, p.z), flight);
    },
    loop: () => {
      rig.look(V(-sim.layout.straight / 2 - 2, 4.5, sim.layout.radius + 7), V(0, 0.8, 0), flight);
    },
    induct: () => {
      const p = sim.layout.inductLane[2];
      rig.look(V(p.x + 5, 4.2, p.z + 6), V(p.x - 0.5, 0.8, p.z), flight);
    },
    dock: () => {
      const d = sim.layout.docks[Math.floor(sim.layout.docks.length / 2)].door;
      rig.look(V(d.x + 14, 9, d.z + 12), V(d.x + 3, 0.5, d.z), flight);
    },
  };
  /** Straight down over the whole hall. */
  const topView = () => {
    const b = sim.layout.bounds;
    const w = Math.max(b.maxX - b.minX, (b.maxZ - b.minZ) * camera.aspect) + 8;
    const h = (w * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.aspect;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    rig.look(V(cx, h, cz + 0.01), V(cx, 0, cz));
  };
  /** Stand next to the box erector, watching boxes come out onto the loop, in walk mode. */
  const walkToErector = (seconds: number) => {
    const il = sim.layout.inductLane;
    const last = il[il.length - 1];
    // Up the lane from the erector, off to one side: boxes come out of it towards the viewer.
    const eye = V(last.x + 2.3, 1.65, last.z - 3.3);
    const at = V(last.x - 0.3, 0.85, last.z + 0.3);
    const d = at.clone().sub(eye);
    rig.walkTo(eye, Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)), seconds);
  };
  const flyTo = (name: string, seconds = 1.6) => {
    const f = views[name as keyof typeof views];
    if (!f) return;
    flight = seconds;
    f();
    flight = 0;
  };
  const tour = new Tour(TOUR_STEPS, (v) => flyTo(v));

  // ---------- GUI ----------
  const gui = new GUI({ title: 'Kurvi packing loop' });
  const play = gui.addFolder('Playback');
  play.add(params, 'speed', { '¼×': 0.25, '1×': 1, '2×': 2, '4×': 4, '10×': 10, '30×': 30, '60×': 60, '120×': 120, '300×': 300, '600×': 600 }).name('speed');
  play.add(params, 'paused');
  const live = (name: keyof SimConfig) => (v: unknown) => sim.set({ [name]: v } as Partial<SimConfig>);
  const dem = gui.addFolder('Demand (live)');
  dem.add(params, 'orderRate', 50, 1500, 10).name('orders / hour').onChange(live('orderRate'));
  dem.add(params, 'theme', THEMES).name('theme surge').onChange(live('theme'));
  dem.add(params, 'themeShare', 0, 1, 0.05).name('theme share').onChange(live('themeShare'));
  dem.add(params, 'tripOrders', 4, 80, 1).name('orders / truck').onChange(live('tripOrders'));
  const ops = gui.addFolder('Operations (live)');
  ops.add(params, 'release', RELEASE_POLICIES).name('release policy').onChange(live('release'));
  ops.add(params, 'boxing', BOXING_STRATEGIES).name('box planning').onChange(live('boxing'));
  ops.add(params, 'wipCap', 20, 400, 5).name('max boxes in loop').onChange(live('wipCap'));
  ops.add(params, 'unitTime', 1, 15, 0.1).name('sec / unit (mean)').onChange(live('unitTime'));
  ops.add(params, 'unitTimeCv', 0, 1, 0.05).name('sec / unit spread (σ/μ)').onChange(live('unitTimeCv'));
  ops.add(params, 'unitTimeMin', 0.5, 6, 0.1).name('fastest unit (s)').onChange(live('unitTimeMin'));
  ops.add(params, 'supportStaffRatio', 0, 2, 0.05).name('support h / packer h').onChange(live('supportStaffRatio'));
  ops.add(params, 'boxHandlingTime', 0, 15, 0.5).name('sec / box visit').onChange(live('boxHandlingTime'));
  ops.add(params, 'inductInterval', 0.5, 10, 0.1).name('induct interval s').onChange(live('inductInterval'));
  const lay = gui.addFolder('Layout (restart)');
  lay.add(params, 'stations', 4, 40, 1).name('stations');
  lay.add(params, 'cacheSize', 1, 8, 1).name('cache boxes / station');
  lay.add(params, 'outLaneSize', 1, 4, 1).name('out-lane boxes / station');
  lay.add(params, 'stationSpacing', 6, 14, 1).name('station spacing (cells)');
  lay.add(params, 'conveyorSpeed', 0.2, 1.5, 0.05).name('conveyor m/s');
  lay.add(params, 'slotting', SLOTTING_STRATEGIES).name('product slotting');
  lay.add(params, 'avgOrderValue', 300, 3000, 50).name('avg order NOK');
  lay.add(params, 'seed', 1, 999, 1);
  lay.add({ restart: () => start() }, 'restart').name('↻ Restart with these');
  const cam = gui.addFolder('Camera');
  const camButtons = {
    tutorial: () => tour.open(),
    overview: () => flyTo('overview', 1.2),
    induct: () => flyTo('induct', 1.2),
    station: () => flyTo('station', 1.2),
    loop: () => flyTo('loop', 1.2),
    dock: () => flyTo('dock', 1.2),
  };
  cam.add(camButtons, 'tutorial').name('▶ Tutorial');
  cam.add(camButtons, 'overview').name('Overview');
  cam.add(camButtons, 'induct').name('Box erector');
  cam.add(camButtons, 'station').name('Packing station');
  cam.add(camButtons, 'loop').name('Loop');
  cam.add(camButtons, 'dock').name('Dock & trucks');
  const camState = { walk: false };
  const walkCtl = cam.add(camState, 'walk').name('Walk mode (M)').onChange((on: boolean) => rig.setMode(on ? 'walk' : 'orbit'));
  const hint = document.createElement('div');
  hint.id = 'camhint';
  document.body.appendChild(hint);
  const crosshair = document.createElement('div');
  crosshair.id = 'crosshair';
  document.body.appendChild(crosshair);
  const controls = document.createElement('div');
  controls.id = 'controls';
  document.body.appendChild(controls);
  const kbd = (k: string) => k.split(' ').map((x) => `<kbd>${x}</kbd>`).join('');
  let controlsTimer = 0;
  const shownControls = new Set<string>();
  /** The key card in the middle of the screen: shown when a mode starts, then fades out. */
  const showControls = (force = false) => {
    const m = rig.mode;
    if (!force && shownControls.has(m)) return;
    shownControls.add(m);
    controls.innerHTML = m === 'walk'
      ? `<h3>Walking the floor</h3>
        <div>${kbd('Click')} capture the mouse and look around</div>
        <div>${kbd('W A S D')} walk · ${kbd('Shift')} run</div>
        <div>Look at a box to see what it is, click to open it</div>
        <div>${kbd('Esc')} free the mouse · ${kbd('M')} fly camera</div>`
      : `<h3>Fly camera</h3>
        <div>Drag to rotate · right-drag to move · scroll to zoom to the mouse</div>
        <div>${kbd('W A S D')} fly · ${kbd('Q')}${kbd('E')} down / up · ${kbd('← →')} turn</div>
        <div>Click a box or a station for details · ${kbd('M')} walk</div>`;
    controls.classList.add('on');
    clearTimeout(controlsTimer);
    controlsTimer = window.setTimeout(() => controls.classList.remove('on'), 9000);
  };
  const setHint = () => {
    hint.textContent = rig.mode === 'walk'
      ? (rig.locked ? 'Walk: mouse looks · WASD walk · Shift run · click a box to open it · Esc frees the mouse · M fly'
        : 'Walk: click to capture the mouse · WASD walk · Shift run · M / Esc fly camera')
      : 'Fly: drag rotate · right-drag move · scroll zooms to mouse · WASD fly · Q/E down/up · arrows turn · Shift faster · M walk';
    crosshair.style.display = rig.mode === 'walk' ? 'block' : 'none';
  };
  rig.onModeChange = (m) => {
    camState.walk = m === 'walk';
    walkCtl.updateDisplay();
    setHint();
    if (!rig.flying) showControls();
  };
  rig.onLockChange = (locked) => {
    setHint();
    if (locked) {
      clearTimeout(controlsTimer);
      controlsTimer = window.setTimeout(() => controls.classList.remove('on'), 2500);
    }
  };
  setHint();
  if (window.innerWidth < 700) gui.close();

  // ---------- HUD ----------
  const hud = document.getElementById('hud')!;
  const bars = document.getElementById('bars')!;
  const panel = document.getElementById('station')!;
  let barEls: HTMLElement[] = [];
  /** What the side panel shows. Boxes are kept by reference: the sim updates them in place. */
  let sel: { kind: 'station'; i: number } | { kind: 'box'; box: Box } | null = null;
  function buildBars() {
    bars.innerHTML = '<div class="legend">Station utilisation (10 min) · red = blocked · click for details</div>';
    barEls = sim.stations.map((st, i) => {
      const el = document.createElement('div');
      el.className = 'bar';
      el.innerHTML = `<u></u><i style="background:${ZONE_COLOR[st.zone]}"></i><span>${i + 1}</span>`;
      el.onclick = () => showStation(i);
      bars.appendChild(el);
      return el;
    });
  }
  const fmt = (x: number, d = 0) => x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
  const clock = (t: number) => {
    const h = Math.floor(t / 3600) + 8;
    const m = Math.floor((t % 3600) / 60);
    return `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  function showStation(i: number) {
    if (sel?.kind === 'box') rig.stopFollow();
    sel = { kind: 'station', i };
    panel.style.display = 'block';
    renderPanel();
  }
  function showBox(box: Box) {
    if (sel?.kind === 'box' && sel.box !== box) rig.stopFollow();
    sel = { kind: 'box', box };
    panel.style.display = 'block';
    renderPanel();
  }
  function closePanel() {
    sel = null;
    panel.style.display = 'none';
    rig.stopFollow();
  }
  const boxTarget = (box: Box) => () => (sim.boxes.has(box.id) && box.loc !== Loc.Shipped ? world?.boxPosition(box.id) ?? null : null);
  function followBox(box: Box) {
    const p = world?.boxPosition(box.id);
    if (!p) return;
    // Ride along from a little behind and above, on the side the camera is already on.
    const off = camera.position.clone().sub(p).setY(0);
    if (off.lengthSq() < 0.01) off.set(0, 0, 1);
    off.setLength(2.6).setY(2.1);
    rig.followFrom(boxTarget(box), off, 1.4);
    renderPanel();
  }
  rig.onFollowEnd = () => renderPanel();
  panel.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
    if (act === 'close') closePanel();
    else if (act === 'follow' && sel?.kind === 'box') followBox(sel.box);
    else if (act === 'unfollow') rig.stopFollow();
    else if (act?.startsWith('station:')) showStation(Number(act.slice(8)));
  });
  let panelHtml = '';
  function renderPanel() {
    let html = '';
    if (sel?.kind === 'station') html = stationHtml(sel.i);
    else if (sel?.kind === 'box') html = boxHtml(sel.box);
    // Only touch the DOM when something changed, so buttons don't vanish under the mouse.
    if (html !== panelHtml) {
      panelHtml = html;
      panel.innerHTML = html;
    }
  }
  function stationHtml(i: number): string {
    const st = sim.stations[i];
    const ids = sim.slotting.productsAt[i];
    const util = recentUtil()[i] ?? 0;
    const lane = st.inLane.filter(Boolean).length;
    return `<span class="x" data-act="close">✕</span><h2>Station ${i + 1} · ${st.zone}</h2>
      ${fmt(util * 100)}% busy · ${st.units} units · ${st.boxes} boxes<br/>
      cache ${lane}/${sim.cfg.cacheSize} · ${ids.length} products slotted here<br/>
      <ol>${ids.slice(0, 8).map((id) => `<li>${esc(sim.catalog.byId.get(id)!.name)}</li>`).join('')}</ol>`;
  }
  /** Where a box is, in words. */
  function boxStatus(box: Box): string {
    if (!sim.boxes.has(box.id) || box.loc === Loc.Shipped) return 'Shipped';
    const st = box.station >= 0 ? box.station + 1 : 0;
    switch (box.loc) {
      case Loc.Pending: return 'Waiting for the box erector';
      case Loc.Loop: {
        const next = box.remaining.length ? `heading for station ${box.remaining[0] + 1}` : 'complete, heading for the exit';
        return `On the loop, ${next}${box.laps > 0 ? ` · lap ${box.laps + 1}` : ''}`;
      }
      case Loc.InLane: return sim.stations[box.station].packing === box && simClock >= sim.stations[box.station].packStart ? `Being packed at station ${st}` : `Queued at station ${st}`;
      case Loc.OutLane: return `Packed at station ${st}, waiting to rejoin the loop`;
      case Loc.Outbound: return 'On the conveyor to the dock';
      case Loc.Dock: return `Stacked at door ${(sim.trips.get(box.tripId)?.door ?? 0) + 1}, waiting for the truck`;
      default: return '';
    }
  }
  function boxHtml(box: Box): string {
    const T = simClock;
    const packed = new Map<number, number>();
    let done = 0;
    for (const u of box.placed) {
      if (u.t > T) continue;
      packed.set(u.productId, (packed.get(u.productId) ?? 0) + 1);
      done++;
    }
    const trip = sim.trips.get(box.tripId);
    const route = trip ? ROUTE_NAMES[trip.route % ROUTE_NAMES.length] : '';
    let siblings = 0;
    let nth = 1;
    for (const b of sim.boxes.values()) {
      if (b.orderId !== box.orderId) continue;
      siblings++;
      if (b.id < box.id) nth++;
    }
    const here = (box.loc === Loc.InLane || box.loc === Loc.OutLane) ? box.station : -1;
    // The plan: stations in the order the box meets them, each with what it should pick up there.
    const byStation = new Map<number, typeof box.items>();
    for (const it of box.items) {
      if (!byStation.has(it.station)) byStation.set(it.station, []);
      byStation.get(it.station)!.push(it);
    }
    const plan = [...byStation.entries()].sort((a, b) => a[0] - b[0]).map(([s, items]) => {
      const need = items.reduce((a, it) => a + it.qty, 0);
      const got = items.reduce((a, it) => a + Math.min(it.qty, packed.get(it.productId) ?? 0), 0);
      const state = got >= need ? 'done' : s === here ? 'here' : 'todo';
      const rows = items.map((it) => {
        const n = Math.min(it.qty, packed.get(it.productId) ?? 0);
        const p = sim.catalog.byId.get(it.productId)!;
        return `<li class="${n >= it.qty ? 'done' : ''}"><span class="ck">${n >= it.qty ? '✓' : n > 0 ? '◐' : ''}</span>${esc(p.name)}<em>${n}/${it.qty}</em></li>`;
      }).join('');
      return `<li class="stop ${state}"><div class="sh" data-act="station:${s}"><span class="ck">${state === 'done' ? '✓' : state === 'here' ? '▶' : ''}</span>Station ${s + 1}<em>${got}/${need}</em></div><ul>${rows}</ul></li>`;
    }).join('');
    const following = rig.following;
    const alive = sim.boxes.has(box.id) && box.loc !== Loc.Shipped;
    return `<span class="x" data-act="close">✕</span>
      <h2>Box ${box.id} <span class="chip" style="background:${ZONE_COLOR[box.zone]}">${box.zone}</span></h2>
      <div>Order <b>#${box.orderId}</b>${siblings > 1 ? ` · box ${nth} of ${siblings} in the warehouse` : ''}${route ? ` · truck route ${esc(route)}` : ''}</div>
      <div class="status">${boxStatus(box)}</div>
      <div class="prog"><i style="width:${Math.round((done / Math.max(1, box.units)) * 100)}%"></i></div>
      <div class="muted">${done} of ${box.units} items packed · ${box.items.length} products${box.missedDiverts ? ` · ${box.missedDiverts} full-station pass${box.missedDiverts > 1 ? 'es' : ''}` : ''}</div>
      ${alive ? `<button type="button" class="btn" data-act="${following ? 'unfollow' : 'follow'}">${following ? '■ Stop following' : '▶ Follow this box'}</button>` : ''}
      <h3>Plan</h3><ol class="plan">${plan}</ol>`;
  }
  function recentUtil(): number[] {
    if (utilHist.length < 2) return sim.stations.map(() => 0);
    const a = utilHist[0];
    const b = utilHist[utilHist.length - 1];
    const dt = Math.max(1, b.t - a.t);
    return b.busy.map((x, i) => Math.min(1, Math.max(0, (x - a.busy[i]) / dt)));
  }
  let lastHud = 0;
  function updateHud(now: number) {
    if (now - lastHud < 250) return;
    lastHud = now;
    const s = sim.stats();
    const u = recentUtil();
    const meanU = u.reduce((a, b) => a + b, 0) / Math.max(1, u.length);
    hud.innerHTML = `<h1><b>kurvi</b> packing loop · ${clock(sim.t)} · ${params.paused ? 'paused' : params.speed + '×'}</h1>
      <div class="big">${fmt(s.uphPerPackerRecent)} <small>UPH per packer (10 min)</small></div>
      <table>
      <tr><td>Warehouse UPH (incl. support)</td><td>${fmt(s.uphWarehouseRecent)} <span class="muted">· industry ≈ 300</span></td></tr>
      <tr><td>Line output</td><td>${fmt(s.lineUphRecent)} units/h · ${sim.cfg.stations} packers</td></tr>
      <tr><td>Units packed</td><td>${fmt(s.unitsPacked)}</td></tr>
      <tr><td>Orders in / shipped</td><td>${fmt(s.ordersArrived)} / ${fmt(s.ordersShipped)}</td></tr>
      <tr><td>Boxes in loop / waiting</td><td>${s.boxesInSystem} / ${s.boxesWaiting}</td></tr>
      <tr><td>Station utilisation</td><td>${fmt(meanU * 100)}%</td></tr>
      <tr><td>Stops · laps per box</td><td>${fmt(s.stopsPerBox, 2)} · ${fmt(s.lapsPerBox, 2)}</td></tr>
      <tr><td>Trucks dispatched</td><td>${s.tripsDeparted}</td></tr>
      <tr><td>Dock wait first→last box</td><td>${fmt(s.dockWaitMean / 60, 1)} min (max ${fmt(s.dockWaitMax / 60, 1)})</td></tr>
      <tr><td>Slotting · release</td><td>${sim.cfg.slotting} · ${sim.cfg.release}</td></tr>
      </table><canvas id="chart"></canvas>`;
    drawChart(hud.querySelector('#chart') as HTMLCanvasElement, history.map((h) => h.t), [
      { name: 'per packer', color: '#4ade80', values: history.map((h) => h.packer) },
      { name: 'warehouse', color: '#60a5fa', values: history.map((h) => h.whse) },
    ], [{ value: 310, label: 'industry ~310' }]);
    const bl = blockedHist.length >= 2 ? blockedHist[blockedHist.length - 1].blocked.map((x, i) => (x - blockedHist[0].blocked[i]) / Math.max(1, blockedHist[blockedHist.length - 1].t - blockedHist[0].t)) : [];
    barEls.forEach((el, i) => {
      (el.children[1] as HTMLElement).style.height = `${Math.round(u[i] * 100)}%`;
      (el.children[0] as HTMLElement).style.height = `${Math.round(Math.min(1, bl[i] ?? 0) * 100)}%`;
      el.title = `Station ${i + 1}: ${fmt(u[i] * 100)}% busy`;
    });
    renderPanel();
  }

  // ---------- picking ----------
  const ray = new THREE.Raycaster();
  const centre = new THREE.Vector2(0, 0);
  const mouse = { x: 0, y: 0, over: false, down: false };
  let downAt: { x: number; y: number } | null = null;
  const pickAt = (ndc: THREE.Vector2) => {
    if (!world) return;
    ray.setFromCamera(ndc, camera);
    const box = world.pickBox(ray);
    if (box) return showBox(box);
    const s = world.pickStation(ray);
    if (s >= 0) showStation(s);
  };
  canvas.addEventListener('pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY };
    mouse.down = true;
  });
  canvas.addEventListener('pointerup', (e) => {
    mouse.down = false;
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5 || e.button !== 0) return;
    // In walk mode a click captures the mouse; with it captured, clicks act on the crosshair (onActivate).
    if (rig.mode === 'walk') return;
    pickAt(new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1));
  });
  canvas.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.over = true;
  });
  canvas.addEventListener('pointerleave', () => (mouse.over = false));
  rig.onActivate = () => pickAt(centre);

  // Hover (or, walking, whatever is in the crosshair): a small label that sticks to the box.
  const tip = document.createElement('div');
  tip.id = 'boxtip';
  document.body.appendChild(tip);
  let hovered: Box | null = null;
  let lastHover = 0;
  const tipPos = new THREE.Vector3();
  function updateHover(now: number) {
    if (!world) return;
    if (now - lastHover > 90) {
      lastHover = now;
      hovered = null;
      if (rig.mode === 'walk') {
        ray.setFromCamera(centre, camera);
        const b = world.pickBox(ray);
        if (b && ray.ray.origin.distanceTo(world.boxPosition(b.id, tipPos) ?? ray.ray.origin) < 9) hovered = b;
      } else if (mouse.over && !mouse.down) {
        ray.setFromCamera(new THREE.Vector2((mouse.x / window.innerWidth) * 2 - 1, -(mouse.y / window.innerHeight) * 2 + 1), camera);
        hovered = world.pickBox(ray);
      }
      crosshair.classList.toggle('hit', !!hovered);
      canvas.style.cursor = hovered && rig.mode === 'orbit' ? 'pointer' : '';
      if (hovered) {
        const done = hovered.placed.filter((u) => u.t <= simClock).length;
        tip.innerHTML = `<b>Box ${hovered.id}</b> · order #${hovered.orderId}<br/>${done}/${hovered.units} items · ${boxStatus(hovered).replace(/^On the loop, /, '')}${rig.mode === 'walk' ? '<br/><span class="muted">click to open</span>' : ''}`;
      }
    }
    const p = hovered && world.boxPosition(hovered.id, tipPos);
    if (!p) {
      tip.style.display = 'none';
      return;
    }
    p.y += 0.12;
    p.project(camera);
    if (p.z > 1) {
      tip.style.display = 'none';
      return;
    }
    tip.style.display = 'block';
    tip.style.left = `${((p.x + 1) / 2) * window.innerWidth}px`;
    tip.style.top = `${((1 - p.y) / 2) * window.innerHeight}px`;
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // URL options: ?warm=1800 (pre-run seconds), ?view=station|loop|dock, ?speed=10
  const q = new URLSearchParams(location.search);
  start();
  const warm = Number(q.get('warm') ?? 0);
  if (q.get('speed')) params.speed = Number(q.get('speed'));
  if (warm > 0) {
    while (sim.t < warm) {
      sim.step();
      if (sim.t - lastSample >= 60) {
        lastSample = sim.t;
        if (sim.t > 300) {
          const st = sim.stats();
          history.push({ t: sim.t, packer: st.uphPerPackerRecent, whse: st.uphWarehouseRecent });
        }
      }
      if (sim.tick % 19 === 0 && sim.t > warm - 660) {
        utilHist.push({ t: sim.t, busy: sim.stations.map((s) => s.busyTime) });
        blockedHist.push({ t: sim.t, blocked: sim.stations.map((s) => s.blockedTime) });
      }
    }
    world!.snapshot(true);
    world!.snapshot();
    simClock = sim.t;
  }
  const v = q.get('view') as keyof typeof views | null;
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  loading.remove();
  // Deep links (?view=...) go straight there. Otherwise start looking straight down on the hall, then
  // dive down next to the box erector in walk mode. First visit: the guided tour comes first (forced
  // with ?tour=1, skipped with ?tour=0); the dive follows when it closes. ?intro=0 skips the dive.
  const tourParam = q.get('tour');
  const intro = q.get('intro') !== '0';
  // Landing in walk mode brings up the key card (onModeChange).
  const dive = () => walkToErector(4.2);
  if (v && views[v]) views[v]();
  else {
    topView();
    if (tourParam === '1' || (tourParam !== '0' && !warm && !tourSeen())) {
      tour.onClose = () => {
        tour.onClose = () => {};
        if (intro) dive();
      };
      tour.open();
    } else if (intro) {
      // Hold the top view for a moment, unless someone grabs the camera first.
      let touched = false;
      const touch = () => (touched = true);
      canvas.addEventListener('pointerdown', touch, { once: true });
      canvas.addEventListener('wheel', touch, { once: true, passive: true });
      window.addEventListener('keydown', touch, { once: true });
      window.setTimeout(() => (touched ? showControls(true) : dive()), 1500);
    }
  }
  if (tourParam === '1' && v) tour.open();
  (window as unknown as Record<string, unknown>).__app = { get sim() { return sim; }, get world() { return world; }, rig, camera, showBox, followBox };

  // ---------- loop ----------
  const timer = new THREE.Clock();
  let wall = 0;
  renderer.setAnimationLoop(() => {
    const dtw = Math.min(0.1, timer.getDelta());
    wall += dtw;
    if (!params.paused) simClock += dtw * params.speed;
    // Keep the render clock one tick behind the sim so we can interpolate.
    let steps = 0;
    while (sim.t < simClock && steps < 4000) {
      sim.step();
      world!.snapshot();
      steps++;
      if (sim.t - lastSample >= 60) {
        lastSample = sim.t;
        if (sim.t > 300) {
          const st = sim.stats();
          history.push({ t: sim.t, packer: st.uphPerPackerRecent, whse: st.uphWarehouseRecent });
          if (history.length > 720) history.shift();
        }
      }
      if (sim.tick % 19 === 0) {
        utilHist.push({ t: sim.t, busy: sim.stations.map((s) => s.busyTime) });
        blockedHist.push({ t: sim.t, blocked: sim.stations.map((s) => s.blockedTime) });
        while (utilHist.length > 2 && utilHist[0].t < sim.t - 600) utilHist.shift();
        while (blockedHist.length > 2 && blockedHist[0].t < sim.t - 600) blockedHist.shift();
      }
    }
    if (steps >= 4000) simClock = sim.t; // fell behind: don't spiral
    const T = simClock;
    const alpha = Math.min(1, Math.max(0, (T - (sim.t - sim.dt)) / sim.dt));
    world!.update(T, alpha, wall);
    rig.update(dtw);
    renderer.render(scene, camera);
    updateHud(performance.now());
    updateHover(performance.now());
  });
}

main().catch((e) => {
  document.getElementById('loading')!.textContent = `Failed to start: ${e}`;
  console.error(e);
});
