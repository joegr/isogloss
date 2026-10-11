import * as d3 from "d3";

/** Small shared helpers (from Demogi's util.ts, minus the GeoCRM record helpers). */

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export const pct = d3.format(".0%");
export const num = d3.format(",");

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: number | undefined;
  return (...a: A) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

export const tooltip = {
  el: () => document.getElementById("tooltip")!,
  show(html: string, ev: MouseEvent) {
    const el = this.el();
    el.innerHTML = html;
    el.hidden = false;
    const { innerWidth: w, innerHeight: h } = window;
    const r = el.getBoundingClientRect();
    let x = ev.clientX + 14;
    let y = ev.clientY + 14;
    if (x + r.width > w - 8) x = ev.clientX - r.width - 14;
    if (y + r.height > h - 8) y = ev.clientY - r.height - 14;
    el.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  },
  hide() {
    this.el().hidden = true;
  },
};
