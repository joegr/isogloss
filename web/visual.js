/* The circle.
 *
 * Everything you see is driven by the synthesiser's own parameter track rather
 * than by an FFT of the output. That is a deliberate choice: the track is exact
 * and noise-free, so the picture shows what the *model* is doing, not what a
 * spectrum analyser guesses it did. The mapping is meant to be legible:
 *
 *   radius      voicing amplitude
 *   hue         F2 — the front/back axis of the vowel space. Front vowels burn
 *               warm, back vowels go cold. You are watching the vowel space.
 *   lobes       F1 (2 lobes), F2 (3), F3 (5), each pushed by how far that
 *               formant sits from its own running mean
 *   spin        F0
 *   hook        low F3, i.e. r-colouring — the circle grows a rhotic barb
 *   pixels      frication. [s] throws a storm of them; a vowel throws none
 *   echoes      one expanding ghost ring per glottal pulse
 */

const TAU = Math.PI * 2;

export class CircleView {
  constructor(canvas) {
    this.canvas = canvas;
    paper.setup(canvas);
    this.pixels = [];
    this.echoes = [];
    this.spin = 0;
    this.smooth = { av: 0, af: 0, f1: 500, f2: 1500, f3: 2500, f0: 120 };
    this.pulsePhase = 0;
    this.layerEcho = new paper.Layer();
    this.layerPixel = new paper.Layer();
    this.layerCore = new paper.Layer();

    this.core = new paper.Path({ closed: true, parent: this.layerCore });
    this.inner = new paper.Path({ closed: true, parent: this.layerCore });
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    paper.view.viewSize = new paper.Size(
      this.canvas.clientWidth, this.canvas.clientHeight);
    this.centre = paper.view.center;
    this.base = Math.min(paper.view.size.width, paper.view.size.height) * 0.19;
  }

  /* frame: {av, af, ah, f0, f1, f2, f3, nasal} or null when idle */
  update(frame, dt) {
    const s = this.smooth;
    const k = Math.min(1, dt * 18);
    const f = frame || { av: 0, af: 0, ah: 0, f0: 0, f1: 500, f2: 1500, f3: 2500, nasal: 0 };
    s.av += (f.av - s.av) * k;
    s.af += (f.af - s.af) * k;
    s.f1 += (f.f1 - s.f1) * k;
    s.f2 += (f.f2 - s.f2) * k;
    s.f3 += (f.f3 - s.f3) * k;
    s.f0 += (f.f0 - s.f0) * (f.f0 > 0 ? k : k * 0.3);

    this.spin += dt * (0.25 + (s.f0 / 900)) * (frame ? 1 : 0.15);

    this.drawCore(s);
    this.emit(f, s, dt);
    this.step(dt);
    paper.view.update();
  }

  hue(f2) {
    // 700 Hz (back) → 205° cold blue; 2400 Hz (front) → 32° hot amber.
    const t = Math.min(1, Math.max(0, (f2 - 700) / 1700));
    return 205 - t * 173;
  }

  drawCore(s) {
    const N = 168;
    const R = this.base * (0.72 + 0.85 * s.av);
    const a1 = 26 * Math.min(1, Math.abs(s.f1 - 520) / 300) * s.av;
    const a2 = 30 * Math.min(1, Math.abs(s.f2 - 1500) / 900) * s.av;
    const a3 = 16 * Math.min(1, Math.abs(s.f3 - 2500) / 900) * s.av;
    // r-colouring: F3 collapsing toward 1700 Hz pulls one side of the rim in,
    // so a rhotic vowel is visibly lopsided rather than merely a different hue.
    const hook = Math.min(1, Math.max(0, (2350 - s.f3) / 650)) * s.av;

    const pts = [];
    for (let i = 0; i < N; i++) {
      const th = (i / N) * TAU;
      const r = R
        + a1 * Math.sin(2 * th + this.spin)
        + a2 * Math.sin(3 * th - this.spin * 1.7)
        + a3 * Math.sin(5 * th + this.spin * 2.3)
        - hook * 34 * Math.max(0, Math.cos(th - this.spin * 0.6)) ** 3
        + s.af * 12 * (Math.random() - 0.5);
      pts.push(new paper.Point(
        this.centre.x + Math.cos(th) * r,
        this.centre.y + Math.sin(th) * r));
    }

    const h = this.hue(s.f2);
    this.core.removeSegments();
    this.core.addSegments(pts);
    this.core.smooth({ type: "continuous" });
    this.core.strokeColor = new paper.Color({ hue: h, saturation: 0.75,
      lightness: 0.60, alpha: 0.35 + 0.55 * s.av });
    this.core.strokeWidth = 1.6 + 3.4 * s.av;
    this.core.fillColor = new paper.Color({ hue: h, saturation: 0.65,
      lightness: 0.5, alpha: 0.07 + 0.14 * s.av });

    const ipts = pts.map((p) => this.centre.add(
      p.subtract(this.centre).multiply(0.42 + 0.16 * Math.sin(this.spin * 2))));
    this.inner.removeSegments();
    this.inner.addSegments(ipts);
    this.inner.smooth({ type: "continuous" });
    this.inner.strokeColor = new paper.Color({ hue: (h + 40) % 360, saturation: 0.8,
      lightness: 0.65, alpha: 0.10 + 0.4 * s.av });
    this.inner.strokeWidth = 1;
  }

  emit(f, s, dt) {
    // Frication throws pixels. The count is superlinear in `af` so a sibilant
    // is a burst and a voiced fricative is a drizzle.
    const n = Math.round(f.af * f.af * 34);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * TAU;
      const r = this.base * (0.9 + Math.random() * 0.5);
      const sp = 60 + Math.random() * 340 * f.af;
      this.pixels.push({
        x: this.centre.x + Math.cos(th) * r,
        y: this.centre.y + Math.sin(th) * r,
        vx: Math.cos(th) * sp, vy: Math.sin(th) * sp,
        life: 0.35 + Math.random() * 0.75,
        age: 0,
        size: 2 + Math.round(Math.random() * 3) * 2,
        hue: this.hue(Math.min(6600, f.fricCf || 4000)),
      });
    }

    // Aspiration drifts rather than blasts.
    if (f.ah > 0.2 && Math.random() < f.ah * 0.7) {
      const th = Math.random() * TAU;
      this.pixels.push({
        x: this.centre.x + Math.cos(th) * this.base * 1.1,
        y: this.centre.y + Math.sin(th) * this.base * 1.1,
        vx: Math.cos(th) * 40, vy: Math.sin(th) * 40,
        life: 1.1, age: 0, size: 2, hue: 190,
      });
    }

    // One ghost ring per glottal pulse.
    if (s.f0 > 40 && s.av > 0.05) {
      this.pulsePhase += dt * s.f0;
      while (this.pulsePhase >= 1) {
        this.pulsePhase -= 1;
        if (this.echoes.length < 46) {
          this.echoes.push({ r: this.base * 0.7, age: 0,
            life: 0.85, hue: this.hue(s.f2), av: s.av });
        }
      }
    }
    if (this.pixels.length > 1400) this.pixels.splice(0, this.pixels.length - 1400);
  }

  step(dt) {
    this.layerPixel.removeChildren();
    this.layerEcho.removeChildren();

    for (const e of this.echoes) {
      e.age += dt;
      e.r += dt * 170 * (0.5 + e.av);
    }
    this.echoes = this.echoes.filter((e) => e.age < e.life);
    for (const e of this.echoes) {
      const a = (1 - e.age / e.life) ** 2 * 0.30 * e.av;
      const c = new paper.Path.Circle({ center: this.centre, radius: e.r,
        parent: this.layerEcho });
      c.strokeColor = new paper.Color({ hue: e.hue, saturation: 0.7,
        lightness: 0.6, alpha: a });
      c.strokeWidth = 1;
    }

    for (const p of this.pixels) {
      p.age += dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 1 - 1.8 * dt; p.vy *= 1 - 1.8 * dt;
      p.vy += 26 * dt;
    }
    this.pixels = this.pixels.filter((p) => p.age < p.life);
    for (const p of this.pixels) {
      const a = (1 - p.age / p.life) ** 1.5;
      // Snapped to a grid the size of the pixel itself: the whole point is that
      // these read as pixels, not as particles.
      const x = Math.round(p.x / p.size) * p.size;
      const y = Math.round(p.y / p.size) * p.size;
      const r = new paper.Path.Rectangle({
        point: [x, y], size: [p.size, p.size], parent: this.layerPixel });
      r.fillColor = new paper.Color({ hue: p.hue, saturation: 0.85,
        lightness: 0.62, alpha: a * 0.9 });
    }
  }

  clear() {
    this.pixels = [];
    this.echoes = [];
  }
}

/* Sample the synthesiser's parameter track at a playback time. */
export function frameAt(track, t, hop = 0.010) {
  if (!track) return null;
  const i = Math.floor(t / hop);
  if (i < 0 || i >= track.n) return null;
  return {
    av: track.av[i], af: track.af[i], ah: track.ah[i], nasal: track.nasal[i],
    f0: track.f0[i], f1: track.F[0][i], f2: track.F[1][i], f3: track.F[2][i],
    fricCf: track.fricCf[i],
  };
}
