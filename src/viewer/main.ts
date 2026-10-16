import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import GUI from 'lil-gui';
import {
  BOXING_STRATEGIES, DEFAULT_CONFIG, RELEASE_POLICIES, ROUTE_NAMES, SLOTTING_STRATEGIES, THEMES, Simulation,
  type Product, type SimConfig,
} from '../core';
import { loadProductAtlas, probeMaxTextureSize } from './textures';
import { World } from './world';
import { ZONE_COLOR } from './factory';
import { drawChart } from './chart';

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
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 1.5;
  controls.maxDistance = 260;

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

  const views = {
    overview: () => {
      const b = sim.layout.bounds;
      const span = b.maxX - b.minX;
      const fit = (span * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.aspect;
      controls.target.set((b.minX + b.maxX) / 2, 0, 1);
      camera.position.set((b.minX + b.maxX) / 2, fit * 0.72, 1 + fit * 0.62);
    },
    station: () => {
      const g = sim.layout.stations[3];
      const p = g.inLane[g.inLane.length - 1];
      controls.target.set(p.x, 1.0, p.z);
      camera.position.set(p.x + g.tangent.x * 2.2 - g.normal.x * 3.2, 2.6, p.z + g.tangent.z * 2.2 - g.normal.z * 3.2);
    },
    loop: () => {
      controls.target.set(0, 0.8, 0);
      camera.position.set(-sim.layout.straight / 2 - 2, 4.5, sim.layout.radius + 7);
    },
    dock: () => {
      const d = sim.layout.docks[Math.floor(sim.layout.docks.length / 2)].door;
      controls.target.set(d.x + 3, 0.5, d.z);
      camera.position.set(d.x + 14, 9, d.z + 12);
    },
  };

  // ---------- GUI ----------
  const gui = new GUI({ title: 'Oda packing loop' });
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
  cam.add(views, 'overview').name('Overview');
  cam.add(views, 'station').name('Packing station');
  cam.add(views, 'loop').name('Loop curve');
  cam.add(views, 'dock').name('Dock & trucks');
  if (window.innerWidth < 700) gui.close();

  // ---------- HUD ----------
  const hud = document.getElementById('hud')!;
  const bars = document.getElementById('bars')!;
  const panel = document.getElementById('station')!;
  let barEls: HTMLElement[] = [];
  let selected = -1;
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
  function showStation(i: number) {
    selected = i;
    panel.style.display = 'block';
    renderStation();
  }
  function renderStation() {
    if (selected < 0) return;
    const st = sim.stations[selected];
    const ids = sim.slotting.productsAt[selected];
    const util = recentUtil()[selected] ?? 0;
    const lane = st.inLane.filter(Boolean).length;
    panel.innerHTML = `<span class="x">✕</span><h2>Station ${selected + 1} · ${st.zone}</h2>
      ${fmt(util * 100)}% busy · ${st.units} units · ${st.boxes} boxes<br/>
      cache ${lane}/${sim.cfg.cacheSize} · ${ids.length} products slotted here<br/>
      <ol>${ids.slice(0, 8).map((id) => `<li>${sim.catalog.byId.get(id)!.name}</li>`).join('')}</ol>`;
    (panel.querySelector('.x') as HTMLElement).onclick = () => {
      selected = -1;
      panel.style.display = 'none';
    };
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
    hud.innerHTML = `<h1><b>oda</b> packing loop · ${clock(sim.t)} · ${params.paused ? 'paused' : params.speed + '×'}</h1>
      <div class="big">${fmt(s.uphPerPackerRecent)} <small>UPH per packer (10 min)</small></div>
      <table>
      <tr><td>Warehouse UPH (incl. support)</td><td>${fmt(s.uphWarehouseRecent)} <span class="muted">· Oda ≈ 300</span></td></tr>
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
    ], [{ value: 310, label: 'Oda ~310' }]);
    const bl = blockedHist.length >= 2 ? blockedHist[blockedHist.length - 1].blocked.map((x, i) => (x - blockedHist[0].blocked[i]) / Math.max(1, blockedHist[blockedHist.length - 1].t - blockedHist[0].t)) : [];
    barEls.forEach((el, i) => {
      (el.children[1] as HTMLElement).style.height = `${Math.round(u[i] * 100)}%`;
      (el.children[0] as HTMLElement).style.height = `${Math.round(Math.min(1, bl[i] ?? 0) * 100)}%`;
      el.title = `Station ${i + 1}: ${fmt(u[i] * 100)}% busy`;
    });
    renderStation();
    void ROUTE_NAMES;
  }

  // ---------- picking ----------
  const ray = new THREE.Raycaster();
  let downAt: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5 || !world) return;
    const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const s = world.pickStation(ray);
    if (s >= 0) showStation(s);
  });

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
  (v && views[v] ? views[v] : views.overview)();
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  loading.remove();
  (window as unknown as Record<string, unknown>).__app = { get sim() { return sim; }, get world() { return world; } };

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
    controls.update();
    renderer.render(scene, camera);
    updateHud(performance.now());
  });
}

main().catch((e) => {
  document.getElementById('loading')!.textContent = `Failed to start: ${e}`;
  console.error(e);
});
