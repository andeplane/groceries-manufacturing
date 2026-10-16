import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Product } from '../core';
import { ProductLayer, productMaterial, SHAPE_TYPES, type ProductLook } from '../products3d';
import { labelTexture, loadProductAtlas, probeMaxTextureSize } from './textures';

const BASE = import.meta.env.BASE_URL;
const PER_ROW = 6;
const COLS = 5;

async function main() {
  const maxTex = probeMaxTextureSize();
  const [products, atlas] = await Promise.all([
    fetch(`${BASE}products.json`).then((r) => r.json() as Promise<Product[]>),
    loadProductAtlas(BASE, maxTex),
  ]);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe9e6e1);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.7;
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(2, 6, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.5, far: 30 });
  scene.add(sun, new THREE.HemisphereLight(0xffffff, 0xb0a898, 0.6));

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const layer = new ProductLayer(productMaterial(atlas.texture), 64);
  scene.add(layer.group);
  const pitch = 0.32;
  const cellW = PER_ROW * pitch + 0.5;
  const cellD = 0.85;
  const rows = Math.ceil(SHAPE_TYPES.length / COLS);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(COLS * cellW + 2, rows * cellD + 2), new THREE.MeshStandardMaterial({ color: 0xf4f1ec, roughness: 0.8 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const picks: { box: THREE.Box3; name: string }[] = [];
  layer.begin();
  SHAPE_TYPES.forEach((shape, idx) => {
    const r = Math.floor(idx / COLS);
    const cx = (idx % COLS - (COLS - 1) / 2) * cellW;
    const list = products.filter((p) => p.shape === shape && p.tile);
    // deterministic spread across the list
    const chosen = Array.from({ length: Math.min(PER_ROW, list.length) }, (_, i) => list[Math.floor((i * list.length) / Math.min(PER_ROW, list.length))]);
    const z = (r - (rows - 1) / 2) * cellD;
    chosen.forEach((p, i) => {
      const x = cx + (i - PER_ROW / 2 + 0.5) * pitch;
      const look: ProductLook = { shape, rect: atlas.remap(p.tile!), color: new THREE.Color(p.col ?? '#ccc') };
      const s = new THREE.Vector3(p.w / 100, p.h / 100, p.d / 100);
      const k = Math.min(1, 0.27 / Math.max(s.x, s.z), 0.4 / s.y);
      s.multiplyScalar(k);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), s);
      layer.add(look, m);
      picks.push({ box: new THREE.Box3(new THREE.Vector3(x - s.x / 2, 0, z - s.z / 2), new THREE.Vector3(x + s.x / 2, s.y, z + s.z / 2)), name: `${p.name} · ${shape} · ${p.w}×${p.h}×${p.d} cm` });
    });
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture([shape], { width: 420 }) }));
    tag.scale.set(0.55, 0.11, 1);
    tag.position.set(cx, 0.06, z + 0.3);
    scene.add(tag);
  });
  layer.end();
  layer.group.children.forEach((m) => (m.castShadow = true));

  const focus = new URLSearchParams(location.search).get('type');
  const fi = focus ? SHAPE_TYPES.indexOf(focus as never) : -1;
  if (fi >= 0) {
    const fx = (fi % COLS - (COLS - 1) / 2) * cellW;
    const fz = (Math.floor(fi / COLS) - (rows - 1) / 2) * cellD;
    controls.target.set(fx, 0.08, fz);
    camera.position.set(fx + 0.3, 0.75, fz + 1.5);
  } else {
    camera.position.set(0, 7, rows * cellD * 0.5 + 6.5);
    controls.target.set(0, 0, 0.3);
  }

  const tip = document.getElementById('tip')!;
  const ray = new THREE.Raycaster();
  window.addEventListener('pointermove', (e) => {
    ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    let best: string | null = null;
    let bestD = Infinity;
    const hit = new THREE.Vector3();
    for (const p of picks) {
      if (ray.ray.intersectBox(p.box, hit)) {
        const d = hit.distanceTo(ray.ray.origin);
        if (d < bestD) {
          bestD = d;
          best = p.name;
        }
      }
    }
    tip.style.display = best ? 'block' : 'none';
    if (best) {
      tip.textContent = best;
      tip.style.left = `${e.clientX + 12}px`;
      tip.style.top = `${e.clientY + 12}px`;
    }
  });
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}
main();
