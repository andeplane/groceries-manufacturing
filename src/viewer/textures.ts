import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function fibres(ctx: CanvasRenderingContext2D, w: number, h: number, n: number, alpha: number) {
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    ctx.strokeStyle = `rgba(${Math.random() < 0.5 ? '90,60,30' : '255,235,200'},${alpha * Math.random()})`;
    ctx.lineWidth = 0.6 + Math.random();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 14, y + (Math.random() - 0.5) * 3);
    ctx.stroke();
  }
}

/** Kraft cardboard with the oda wordmark (outer sides of a box). */
export function cardboardTexture(withLogo: boolean): THREE.Texture {
  const [c, ctx] = canvas(512, 256);
  ctx.fillStyle = withLogo ? '#c69c6d' : '#a97f52';
  ctx.fillRect(0, 0, 512, 256);
  fibres(ctx, 512, 256, 1800, 0.25);
  if (withLogo) {
    ctx.fillStyle = '#2b1d14';
    ctx.font = '600 92px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('oda', 256, 138);
    ctx.font = 'italic 22px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.fillText('Det du trenger,', 24, 40);
    ctx.fillText('levert på døra', 24, 66);
  }
  // Edge shading
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, 'rgba(0,0,0,0.08)');
  g.addColorStop(0.1, 'rgba(0,0,0,0)');
  g.addColorStop(0.9, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Epoxy warehouse floor. */
export function floorTexture(): THREE.Texture {
  const [c, ctx] = canvas(1024, 1024);
  ctx.fillStyle = '#8d9196';
  ctx.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 40000; i++) {
    const v = 120 + Math.random() * 40;
    ctx.fillStyle = `rgba(${v},${v + 2},${v + 6},0.18)`;
    ctx.fillRect(Math.random() * 1024, Math.random() * 1024, 2, 2);
  }
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const r = 40 + Math.random() * 160;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(70,72,76,0.08)');
    g.addColorStop(1, 'rgba(70,72,76,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  // Slab joints
  ctx.strokeStyle = 'rgba(40,40,44,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, 1024, 1024);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** A text label as a sprite-ready texture. */
export function labelTexture(lines: string[], opts: { bg?: string; fg?: string; width?: number; band?: string } = {}): THREE.CanvasTexture {
  const w = opts.width ?? 256;
  const lh = 56;
  const h = lh * lines.length + 24;
  const [c, ctx] = canvas(w, h);
  ctx.fillStyle = opts.bg ?? 'rgba(20,24,30,0.85)';
  roundRect(ctx, 0, 0, w, h, 18);
  ctx.fill();
  if (opts.band) {
    ctx.fillStyle = opts.band;
    ctx.fillRect(0, h - 10, w, 10);
  }
  ctx.fillStyle = opts.fg ?? '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    ctx.font = i === 0 ? '700 44px "Helvetica Neue", Arial, sans-serif' : '500 34px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(l, w / 2, 12 + lh * i + lh / 2);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Truck side: white with the oda wordmark. */
export function truckTexture(): THREE.Texture {
  const [c, ctx] = canvas(512, 256);
  ctx.fillStyle = '#f4f4f2';
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = '#e9542f';
  ctx.fillRect(0, 214, 512, 42);
  ctx.fillStyle = '#1d1d1b';
  ctx.font = '700 110px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('oda', 256, 112);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Combine the six 2048² product atlases into one texture (scaled down if the GPU needs it) so all
 * products can share one material. Returns the texture and a function remapping tile UVs.
 */
export async function loadProductAtlas(base: string, maxTextureSize = 4096, count = 6): Promise<{
  texture: THREE.Texture;
  remap: (tile: [number, number, number, number, number]) => [number, number, number, number];
}> {
  const cols = 3;
  const rows = Math.ceil(count / cols);
  // Full-resolution cells (64 px per product) when the GPU allows a 6144-wide texture.
  const cell = maxTextureSize >= 2048 * cols ? 2048 : 1024;
  const [c, ctx] = canvas(cols * cell, rows * cell);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, (i % cols) * cell, Math.floor(i / cols) * cell, cell, cell);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = `${base}atlas/base-${i}.jpg`;
      }),
    ),
  );
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  const remap = (tile: [number, number, number, number, number]): [number, number, number, number] => {
    const [a, u0, v0, u1, v1] = tile;
    const col = a % cols;
    const row = Math.floor(a / cols);
    // Atlas v runs from the top; CanvasTexture is flipped so texture v runs from the bottom.
    const U = (u: number) => (col + u) / cols;
    const V = (v: number) => 1 - (row + v) / rows;
    return [U(u0), V(v1), U(u1), V(v0)];
  };
  return { texture, remap };
}

export function probeMaxTextureSize(): number {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    return gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 4096;
  } catch {
    return 4096;
  }
}
