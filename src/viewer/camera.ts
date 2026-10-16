import * as THREE from 'three';

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
const MIN_Y = 0.35;
const MAX_Y = 220;
const DRAG_ROTATE = 0.005; // rad per pixel
const LOOK_SENSITIVITY = 0.0022; // rad per pixel with the mouse captured

const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space'];
const TURN_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

interface Drag {
  kind: 'rotate' | 'pan' | 'look';
  x: number;
  y: number;
  pivot: THREE.Vector3;
  /** Pan: the world point under the cursor that stays under the cursor. */
  grab: THREE.Vector3;
  plane: THREE.Plane;
}

interface Tween {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromYaw: number;
  fromPitch: number;
  toYaw: number;
  toPitch: number;
  t: number;
  dur: number;
  /** Mode to switch to when the flight lands. */
  then: CameraMode;
  /** Positions are relative to the followed point. */
  rel: boolean;
}

/**
 * A free camera with two modes, built on the camera's own position and a yaw/pitch (no orbit target).
 *
 * Orbit mode: drag rotates around whatever is in the middle of the view (or a followed box), right-drag
 * (or Shift-drag) grabs the floor and slides it, the wheel moves towards the point under the cursor,
 * WASD flies level, Q/E moves the camera itself down/up and the arrow keys turn on the spot.
 *
 * Walk mode: first person at eye height. Click captures the mouse like a game (Esc releases it),
 * WASD walks, Shift runs. With the mouse captured, a click calls `onActivate` for whatever is in the crosshair.
 * M toggles the mode.
 */
export class CameraRig {
  mode: CameraMode = 'orbit';
  locked = false;
  onModeChange: (mode: CameraMode) => void = () => {};
  onLockChange: (locked: boolean) => void = () => {};
  /** Click with the mouse captured (walk mode). */
  onActivate: () => void = () => {};
  /** A followed point disappeared (e.g. the box was shipped) or following was cancelled. */
  onFollowEnd: () => void = () => {};

  yaw = 0;
  pitch = -0.6;
  private keys = new Set<string>();
  private drag: Drag | null = null;
  private zoom = { left: 0, dir: new THREE.Vector3() };
  private tween: Tween | null = null;
  private follow: (() => THREE.Vector3 | null) | null = null;
  private followLast = new THREE.Vector3();

  private v = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private camUp = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private ray = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ndc = new THREE.Vector2();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    private walkArea: () => WalkArea,
    /** What drags and zooms can snap to (falls back to the floor plane). */
    private pickRoot: () => THREE.Object3D | null = () => null,
  ) {
    camera.rotation.order = 'YXZ';

    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (e.code === 'KeyM' && !e.repeat) {
        this.setMode(this.mode === 'orbit' ? 'walk' : 'orbit');
        return;
      }
      if (e.code === 'Escape' && this.mode === 'walk' && !this.locked) {
        this.setMode('orbit');
        return;
      }
      if (MOVE_KEYS.includes(e.code) || TURN_KEYS.includes(e.code) || e.key === 'Shift') {
        this.keys.add(e.code === 'ShiftLeft' || e.code === 'ShiftRight' ? 'Shift' : e.code);
        if (TURN_KEYS.includes(e.code) || e.code === 'Space') e.preventDefault();
        if (e.key !== 'Shift') this.tween = null;
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code === 'ShiftLeft' || e.code === 'ShiftRight' ? 'Shift' : e.code);
    });
    window.addEventListener('blur', () => this.keys.clear());

    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => this.pointerDown(e));
    dom.addEventListener('pointermove', (e) => this.pointerMove(e));
    const end = () => (this.drag = null);
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('wheel', (e) => this.wheel(e), { passive: false });

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === dom;
      if (locked === this.locked) return;
      this.locked = locked;
      this.drag = null;
      this.onLockChange(locked);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * LOOK_SENSITIVITY;
      this.pitch = clamp(this.pitch - e.movementY * LOOK_SENSITIVITY, -1.45, 1.45);
    });
  }

  // ---------- input ----------

  private pointerDown(e: PointerEvent) {
    this.tween = null;
    if (this.mode === 'walk') {
      if (this.locked) {
        if (e.button === 0) this.onActivate();
        return;
      }
      if (e.pointerType === 'mouse' && e.button === 0) {
        // Capture the mouse like a game; a plain drag still looks around if that is refused.
        try {
          const req = this.dom.requestPointerLock() as unknown;
          if (req instanceof Promise) req.catch(() => {});
        } catch {
          // Not supported: drag to look instead.
        }
      }
      this.startDrag(e, 'look');
      return;
    }
    const pan = e.button === 2 || e.button === 1 || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey));
    this.startDrag(e, pan ? 'pan' : 'rotate');
  }

  private startDrag(e: PointerEvent, kind: Drag['kind']) {
    const d: Drag = { kind, x: e.clientX, y: e.clientY, pivot: new THREE.Vector3(), grab: new THREE.Vector3(), plane: new THREE.Plane() };
    if (kind === 'rotate') d.pivot.copy(this.pivot());
    if (kind === 'pan') {
      const hit = this.surfaceAt(e.clientX, e.clientY) ?? this.camera.position.clone().addScaledVector(this.forward(), 10);
      d.grab.copy(hit);
      d.plane.set(this.up, -hit.y);
    }
    this.drag = d;
    try {
      this.dom.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events have no active pointer.
    }
  }

  private pointerMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || this.locked) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.kind === 'look') {
      this.yaw -= dx * 0.004;
      this.pitch = clamp(this.pitch - dy * 0.004, -1.45, 1.45);
    } else if (d.kind === 'rotate') {
      this.rotateAround(d.pivot, -dx * DRAG_ROTATE, -dy * DRAG_ROTATE);
    } else {
      this.panTo(d, e.clientX, e.clientY);
    }
    d.x = e.clientX;
    d.y = e.clientY;
    this.apply();
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    if (this.mode !== 'orbit') return;
    this.tween = null;
    const cam = this.camera.position;
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const notches = clamp(delta / 100, -4, 4);
    const hit = this.surfaceAt(e.clientX, e.clientY);
    const dir = this.ray.ray.direction.clone();
    const dist = hit ? hit.distanceTo(cam) : Math.max(8, cam.y * 1.5);
    // Each notch covers a share of the distance to the point under the cursor: fast far away, gentle up close.
    let step = -notches * Math.max(0.25, dist * 0.2);
    if (step > 0) step = Math.min(step, Math.max(0, dist - 0.5 - Math.max(0, this.zoom.left)));
    if (step < 0 && dir.y < 0) step = Math.max(step, -((MAX_Y - cam.y) / -dir.y));
    this.zoom.dir.copy(dir);
    this.zoom.left += step;
  }

  // ---------- operations ----------

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.tween = null;
    this.drag = null;
    this.zoom.left = 0;
    const cam = this.camera.position;
    if (mode === 'walk') {
      this.stopFollow();
      // Stand a couple of metres short of whatever the camera was looking at.
      if (cam.y > EYE_HEIGHT + 0.5) {
        const p = this.pivot();
        cam.set(p.x + Math.sin(this.yaw) * 2.5, EYE_HEIGHT, p.z + Math.cos(this.yaw) * 2.5);
        this.pitch = -0.12;
      }
      this.pitch = clamp(this.pitch, -1.45, 1.45);
      this.clampWalk();
    } else if (this.locked) {
      document.exitPointerLock();
    }
    this.mode = mode;
    this.apply();
    this.onModeChange(mode);
  }

  /** Point the camera from `position` at `target`, optionally flying there over `seconds`. */
  look(position: THREE.Vector3Like, target: THREE.Vector3Like, seconds = 0): void {
    const dir = this.v.set(target.x - position.x, target.y - position.y, target.z - position.z).normalize();
    const yaw = Math.atan2(-dir.x, -dir.z);
    const pitch = Math.asin(clamp(dir.y, -1, 1));
    this.fly(position, yaw, pitch, seconds, 'orbit');
  }

  /** Fly to a standing spot and continue in walk mode. */
  walkTo(position: THREE.Vector3Like, yaw: number, pitch: number, seconds: number): void {
    this.fly({ x: position.x, y: EYE_HEIGHT, z: position.z }, yaw, pitch, seconds, 'walk');
  }

  private fly(position: THREE.Vector3Like, yaw: number, pitch: number, seconds: number, then: CameraMode) {
    if (this.mode === 'walk') this.setMode('orbit');
    this.zoom.left = 0;
    if (seconds <= 0) {
      this.camera.position.copy(position);
      this.yaw = yaw;
      this.pitch = pitch;
      this.tween = null;
      this.apply();
      if (then === 'walk') this.setMode('walk');
      return;
    }
    // Turn the short way round.
    let toYaw = yaw;
    while (toYaw - this.yaw > Math.PI) toYaw -= Math.PI * 2;
    while (toYaw - this.yaw < -Math.PI) toYaw += Math.PI * 2;
    this.tween = {
      fromPos: this.camera.position.clone(),
      toPos: new THREE.Vector3().copy(position),
      fromYaw: this.yaw,
      fromPitch: this.pitch,
      toYaw,
      toPitch: pitch,
      t: 0,
      dur: seconds,
      then,
      rel: false,
    };
  }

  get flying(): boolean {
    return this.tween !== null;
  }

  /** Keep the camera moving with a point (e.g. a box), keeping the current offset. */
  startFollow(target: () => THREE.Vector3 | null): void {
    const p = target();
    if (!p) return;
    if (this.mode === 'walk') this.setMode('orbit');
    this.follow = target;
    this.followLast.copy(p);
  }

  /** Follow a point, gliding to `offset` from it (and turning to face it) over `seconds`. */
  followFrom(target: () => THREE.Vector3 | null, offset: THREE.Vector3, seconds = 1.4): void {
    this.startFollow(target);
    if (!this.follow) return;
    const dir = offset.clone().negate().normalize();
    let toYaw = Math.atan2(-dir.x, -dir.z);
    while (toYaw - this.yaw > Math.PI) toYaw -= Math.PI * 2;
    while (toYaw - this.yaw < -Math.PI) toYaw += Math.PI * 2;
    this.zoom.left = 0;
    this.tween = {
      fromPos: this.camera.position.clone().sub(this.followLast),
      toPos: offset.clone(),
      fromYaw: this.yaw,
      fromPitch: this.pitch,
      toYaw,
      toPitch: Math.asin(clamp(dir.y, -1, 1)),
      t: 0,
      dur: seconds,
      then: 'orbit',
      rel: true,
    };
  }

  stopFollow(): void {
    if (!this.follow) return;
    this.follow = null;
    this.onFollowEnd();
  }

  get following(): boolean {
    return this.follow !== null;
  }

  /** Centre of the view on a surface: what drags rotate around. */
  private pivot(): THREE.Vector3 {
    if (this.follow) return this.followLast.clone();
    const r = this.dom.getBoundingClientRect();
    const hit = this.surfaceAt(r.left + r.width / 2, r.top + r.height / 2);
    const cam = this.camera.position;
    if (hit && hit.distanceTo(cam) < 300) return hit;
    return cam.clone().addScaledVector(this.forward(), Math.min(40, Math.max(6, cam.y * 2)));
  }

  private rotateAround(pivot: THREE.Vector3, dYaw: number, dPitch: number) {
    const cam = this.camera.position;
    dPitch = clamp(this.pitch + dPitch, -1.55, 0.35) - this.pitch;
    const off = this.v.subVectors(cam, pivot);
    off.applyAxisAngle(this.up, dYaw);
    const yaw = this.yaw + dYaw;
    // Pitch about the camera's horizontal right axis; never swing below the floor.
    this.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const pitched = off.clone().applyAxisAngle(this.right, dPitch);
    if (pivot.y + pitched.y < MIN_Y) dPitch = 0;
    else off.copy(pitched);
    cam.copy(pivot).add(off);
    this.yaw = yaw;
    this.pitch += dPitch;
  }

  /** Move the camera (keeping its orientation) so the grabbed point stays under the cursor. */
  private panTo(d: Drag, x: number, y: number) {
    this.setRay(x, y);
    const hit = this.ray.ray.intersectPlane(d.plane, this.v);
    const cam = this.camera.position;
    if (hit && hit.distanceTo(cam) < 400) {
      cam.x += d.grab.x - hit.x;
      cam.z += d.grab.z - hit.z;
      return;
    }
    // Looking above the horizon: slide in the screen plane instead.
    const r = this.dom.getBoundingClientRect();
    const depth = Math.max(2, d.grab.distanceTo(cam));
    const perPx = (2 * depth * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / r.height;
    this.right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    cam.addScaledVector(this.right, -(x - d.x) * perPx).addScaledVector(this.camUp, (y - d.y) * perPx);
  }

  private setRay(x: number, y: number) {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.apply();
    this.camera.updateMatrixWorld();
    this.ray.setFromCamera(this.ndc, this.camera);
  }

  private surfaceAt(x: number, y: number): THREE.Vector3 | null {
    this.setRay(x, y);
    const root = this.pickRoot();
    if (root) {
      for (const h of this.ray.intersectObject(root, true)) {
        if ((h.object as THREE.Sprite).isSprite) continue;
        const m = (h.object as THREE.Mesh).material;
        if (m && !Array.isArray(m) && !m.visible) continue;
        return h.point.clone();
      }
    }
    return this.ray.ray.intersectPlane(this.floor, new THREE.Vector3());
  }

  private forward(): THREE.Vector3 {
    const c = Math.cos(this.pitch);
    return this.fwd.set(-Math.sin(this.yaw) * c, Math.sin(this.pitch), -Math.cos(this.yaw) * c);
  }

  private apply() {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  // ---------- per frame ----------

  update(dt: number): void {
    const k = this.keys;
    const cam = this.camera.position;
    if (this.follow) {
      const p = this.follow();
      if (!p) this.stopFollow();
      else {
        cam.add(this.v.subVectors(p, this.followLast));
        this.followLast.copy(p);
      }
    }
    if (this.tween?.rel && !this.follow) this.tween = null;
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
      cam.lerpVectors(tw.fromPos, tw.toPos, e);
      if (tw.rel) cam.add(this.followLast);
      this.yaw = tw.fromYaw + (tw.toYaw - tw.fromYaw) * e;
      this.pitch = tw.fromPitch + (tw.toPitch - tw.fromPitch) * e;
      this.apply();
      if (tw.t >= 1) {
        this.tween = null;
        if (tw.then === 'walk') this.setMode('walk');
      }
      return;
    }
    const speedUp = k.has('Shift') ? RUN_FACTOR : 1;
    const turnX = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0);
    const turnY = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    const moveF = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const moveR = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const moveU = (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    const walk = this.mode === 'walk';
    this.yaw += turnX * TURN_SPEED * dt;
    this.pitch = clamp(this.pitch + turnY * TURN_SPEED * 0.7 * dt, walk ? -1.45 : -1.55, walk ? 1.45 : 0.35);

    if (walk) {
      if (moveF || moveR) {
        const s = (WALK_SPEED * speedUp * dt) / Math.hypot(moveF, moveR);
        this.moveLevel(moveF * s, moveR * s);
        this.clampWalk();
      }
      cam.y = EYE_HEIGHT;
    } else {
      // Smooth wheel zoom along the ray it was aimed at.
      if (Math.abs(this.zoom.left) > 1e-4) {
        const s = this.zoom.left * (1 - Math.exp(-dt * 14));
        cam.addScaledVector(this.zoom.dir, s);
        this.zoom.left -= s;
      }
      if (moveF || moveR || moveU) {
        // Level flight, faster when higher up; Q/E move the camera itself.
        const speed = Math.max(2.5, cam.y * 1.1) * speedUp * dt;
        this.moveLevel(moveF * speed, moveR * speed);
        cam.y += moveU * speed;
      }
      if (cam.y < MIN_Y) {
        cam.y = MIN_Y;
        this.zoom.left = 0;
      }
      cam.y = Math.min(cam.y, MAX_Y);
    }
    this.apply();
  }

  private moveLevel(f: number, r: number) {
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const cam = this.camera.position;
    cam.x += fx * f - fz * r;
    cam.z += fz * f + fx * r;
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
