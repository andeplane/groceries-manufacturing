/** Tiny canvas line chart for the HUD: UPH over simulated time. */
export interface Series {
  name: string;
  color: string;
  values: number[];
  dashed?: boolean;
}

export function drawChart(canvas: HTMLCanvasElement, times: number[], series: Series[], refs: { value: number; label: string }[] = []) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (canvas.width !== W * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const padL = 34;
  const padB = 16;
  const padT = 14;
  const w = W - padL - 6;
  const h = H - padB - padT;
  const all = series.flatMap((s) => s.values).concat(refs.map((r) => r.value));
  const maxV = Math.max(100, ...all) * 1.12;
  const t0 = times[0] ?? 0;
  const t1 = Math.max(t0 + 600, times[times.length - 1] ?? 0);
  const X = (t: number) => padL + ((t - t0) / (t1 - t0)) * w;
  const Y = (v: number) => padT + h - (v / maxV) * h;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = '#9aa4b1';
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  const step = maxV > 800 ? 200 : 100;
  for (let v = 0; v <= maxV; v += step) {
    ctx.beginPath();
    ctx.moveTo(padL, Y(v));
    ctx.lineTo(padL + w, Y(v));
    ctx.stroke();
    ctx.fillText(String(v), 2, Y(v) + 3);
  }
  for (const r of refs) {
    ctx.strokeStyle = 'rgba(233,84,47,0.8)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, Y(r.value));
    ctx.lineTo(padL + w, Y(r.value));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(233,84,47,0.95)';
    ctx.fillText(r.label, padL + w - ctx.measureText(r.label).width - 2, Y(r.value) - 3);
  }
  for (const s of series) {
    if (s.values.length < 2) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.8;
    ctx.setLineDash(s.dashed ? [3, 3] : []);
    ctx.beginPath();
    s.values.forEach((v, i) => (i ? ctx.lineTo(X(times[i]), Y(v)) : ctx.moveTo(X(times[i]), Y(v))));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // legend
  let lx = padL + 4;
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, 3, 10, 3);
    ctx.fillStyle = '#cfd6de';
    ctx.fillText(s.name, lx + 13, 9);
    lx += ctx.measureText(s.name).width + 26;
  }
  // time axis (hours of the shift)
  ctx.fillStyle = '#9aa4b1';
  const hours = (t1 - t0) / 3600;
  const tick = hours > 6 ? 7200 : hours > 2 ? 3600 : 1800;
  for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
    const hh = Math.floor(t / 3600) + 8;
    const mm = Math.floor((t % 3600) / 60);
    ctx.fillText(`${String(hh % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, X(t) - 12, H - 3);
  }
}
