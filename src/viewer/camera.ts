import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type CameraMode = 'orbit' | 'walk';

export interface WalkArea {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const EYE_HEIGHT = 1.65;
const WALK_SPEED = 1.6;
const RUN_FACTOR = 3;
const TURN_SPEED = 1.3; // rad/s for arrow keys
const MIN_FLY_Y = 0.4;

const FLY_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space'];
const TURN_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

/**
 * Orbit mode: OrbitControls (zoom towards the cursor) plus WASD to fly, Q/E or Space for down/up and the
 * arrow keys to turn the view. Walk mode: first person at eye height, drag to look, WASD to walk.
 * Shift moves faster in both. M toggles the mode, Esc leaves walk mode.
 */
export class CameraRig {
  readonly orbit: OrbitControls;
  mode: CameraMode = 'orbit';
  onModeChange: (mode: CameraMode) => void = () => {};

  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private drag: { x: number; y: number } | null = null;
  private v = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  private ray = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private lastWheel = 0;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    private walkArea: () => WalkArea,
    /** What the orbit pivot can snap to (falls back to the floor plane). */
    private pickRoot: () => THREE.Object3D | null = () => null,
  ) {
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enableDamping = true;
    this.orbit.zoomToCursor = true;
    this.orbit.maxPolarAngle = Math.PI * 0.49;
    this.orbit.minDistance = 0.6;
    this.orbit.maxDistance = 260;

    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (e.code === 'KeyM' && !e.repeat) {
        this.setMode(this.mode === 'orbit' ? 'walk' : 'orbit');
        return;
      }
      if (e.code === 'Escape' && this.mode === 'walk') {
        this.setMode('orbit');
        return;
      }
      if (FLY_KEYS.includes(e.code) || TURN_KEYS.includes(e.code) || e.key === 'Shift') {
        this.keys.add(e.code === 'ShiftLeft' || e.code === 'ShiftRight' ? 'Shift' : e.code);
        if (TURN_KEYS.includes(e.code) || e.code === 'Space') e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code === 'ShiftLeft' || e.code === 'ShiftRight' ? 'Shift' : e.code);
    });
    window.addEventListener('blur', () => this.keys.clear());

    // Before OrbitControls sees a wheel or rotate gesture, put the pivot on a real surface:
    // zoom heads for whatever is under the cursor, rotation turns around what is in the middle of the view.
    dom.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'orbit') return;
        const now = performance.now();
        if (now - this.lastWheel > 250) this.repivot(e.clientX, e.clientY, false);
        this.lastWheel = now;
      },
      { capture: true, passive: true },
    );
    dom.addEventListener(
      'pointerdown',
      (e) => {
        if (this.mode === 'orbit' && e.button === 0 && e.pointerType === 'mouse') {
          const r = dom.getBoundingClientRect();
          this.repivot(r.left + r.width / 2, r.top + r.height / 2, true);
        }
      },
      { capture: true },
    );
    dom.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'walk') return;
      this.drag = { x: e.clientX, y: e.clientY };
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (this.mode !== 'walk' || !this.drag) return;
      this.yaw -= (e.clientX - this.drag.x) * 0.004;
      this.pitch = clamp(this.pitch - (e.clientY - this.drag.y) * 0.004, -1.4, 1.4);
      this.drag = { x: e.clientX, y: e.clientY };
    });
    const endDrag = () => (this.drag = null);
    dom.addEventListener('pointerup', endDrag);
    dom.addEventListener('pointercancel', endDrag);
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    const cam = this.camera;
    if (mode === 'walk') {
      // Stand a couple of metres in front of where the orbit camera was looking.
      cam.getWorldDirection(this.fwd);
      this.yaw = Math.atan2(-this.fwd.x, -this.fwd.z);
      this.pitch = -0.12;
      const t = this.orbit.target;
      cam.position.set(t.x + Math.sin(this.yaw) * 2.5, EYE_HEIGHT, t.z + Math.cos(this.yaw) * 2.5);
      this.clampWalk();
      this.orbit.enabled = false;
    } else {
      cam.getWorldDirection(this.fwd);
      this.fwd.y = Math.min(this.fwd.y, -0.25);
      this.fwd.normalize();
      cam.position.y = Math.max(cam.position.y, 3);
      this.orbit.target.copy(cam.position).addScaledVector(this.fwd, 8);
      this.orbit.target.y = Math.max(0, this.orbit.target.y);
      this.orbit.enabled = true;
    }
    this.mode = mode;
    this.drag = null;
    this.onModeChange(mode);
  }

  /**
   * Move the orbit target along the current line of sight to the depth of the surface under (x, y), so the
   * view doesn't jump. With `onSurface` (x, y is the screen centre) the target lands exactly on the surface.
   */
  private repivot(x: number, y: number, onSurface: boolean): void {
    const hit = this.surfaceAt(x, y);
    if (!hit) return;
    const cam = this.camera;
    cam.getWorldDirection(this.fwd);
    const depth = this.v.subVectors(hit, cam.position).dot(this.fwd);
    if (depth < 0.3) return;
    if (onSurface) this.orbit.target.copy(hit);
    else this.orbit.target.copy(cam.position).addScaledVector(this.fwd, depth);
  }

  private surfaceAt(x: number, y: number): THREE.Vector3 | null {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const root = this.pickRoot();
    if (root) {
      for (const h of this.ray.intersectObject(root, true)) {
        if ((h.object as THREE.Sprite).isSprite) continue;
        const m = (h.object as THREE.Mesh).material;
        if (m && !Array.isArray(m) && !m.visible) continue;
        return h.point;
      }
    }
    return this.ray.ray.intersectPlane(this.floor, new THREE.Vector3());
  }

  /** Point the orbit camera (switching back from walk mode if needed). */
  look(position: THREE.Vector3Like, target: THREE.Vector3Like): void {
    if (this.mode === 'walk') this.setMode('orbit');
    this.orbit.target.copy(target);
    this.camera.position.copy(position);
    this.orbit.update();
  }

  update(dt: number): void {
    const k = this.keys;
    const speedUp = k.has('Shift') ? RUN_FACTOR : 1;
    const turnX = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0);
    const turnY = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    const moveF = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const moveR = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const moveU = (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    if (this.mode === 'walk') this.updateWalk(dt, speedUp, turnX, turnY, moveF, moveR);
    else this.updateOrbit(dt, speedUp, turnX, turnY, moveF, moveR, moveU);
  }

  private updateOrbit(dt: number, speedUp: number, turnX: number, turnY: number, moveF: number, moveR: number, moveU: number) {
    const cam = this.camera;
    const target = this.orbit.target;
    if (turnX || turnY) {
      // Turn the view in place: swing the target around the camera.
      const off = this.v.subVectors(target, cam.position);
      const dist = off.length();
      let yaw = Math.atan2(off.x, off.z);
      let pitch = Math.asin(clamp(off.y / Math.max(1e-6, dist), -1, 1));
      yaw += turnX * TURN_SPEED * dt;
      pitch = clamp(pitch + turnY * TURN_SPEED * 0.7 * dt, -1.5, -0.03);
      off.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist);
      // Keep the orbit pivot on or above the floor: pull it back to where the view ray hits the floor.
      if (cam.position.y + off.y < 0) off.multiplyScalar(cam.position.y / -off.y);
      target.copy(cam.position).add(off);
    }
    if (moveF || moveR || moveU) {
      const dist = cam.position.distanceTo(target);
      const speed = Math.max(3, dist * 0.9) * speedUp * dt;
      cam.getWorldDirection(this.fwd);
      this.right.crossVectors(this.fwd, this.up).normalize();
      const step = this.v.set(0, 0, 0)
        .addScaledVector(this.fwd, moveF * speed)
        .addScaledVector(this.right, moveR * speed)
        .addScaledVector(this.up, moveU * speed);
      // Never fly through the floor.
      if (cam.position.y + step.y < MIN_FLY_Y) step.y = MIN_FLY_Y - cam.position.y;
      if (target.y + step.y < 0) step.y = Math.max(step.y, -target.y);
      cam.position.add(step);
      target.add(step);
    }
    this.orbit.update();
  }

  private updateWalk(dt: number, speedUp: number, turnX: number, turnY: number, moveF: number, moveR: number) {
    const cam = this.camera;
    this.yaw += turnX * TURN_SPEED * dt;
    this.pitch = clamp(this.pitch + turnY * TURN_SPEED * 0.7 * dt, -1.4, 1.4);
    if (moveF || moveR) {
      const len = Math.hypot(moveF, moveR);
      const s = (WALK_SPEED * speedUp * dt) / len;
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      cam.position.x += (fx * moveF - fz * moveR) * s;
      cam.position.z += (fz * moveF + fx * moveR) * s;
      this.clampWalk();
    }
    cam.position.y = EYE_HEIGHT;
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private clampWalk() {
    const a = this.walkArea();
    const p = this.camera.position;
    p.x = clamp(p.x, a.minX, a.maxX);
    p.z = clamp(p.z, a.minZ, a.maxZ);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}
