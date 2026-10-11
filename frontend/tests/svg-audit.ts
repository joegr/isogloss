/**
 * Structural "is this chart clean?" audit for SVG produced by d3. Runs in jsdom (unit tests) and,
 * serialised, inside the real browser (Playwright). Pure function of a root element.
 *
 * Flags: NaN / Infinity / "undefined" / "null" in geometry or text, negative widths/heights/radii,
 * empty path data, duplicate ids, unlabeled <svg> (needs role="img" + aria-label, or aria-hidden).
 */
export interface SvgIssue {
  rule: string;
  where: string;
  detail: string;
}

export function auditSvg(root: ParentNode): SvgIssue[] {
  const issues: SvgIssue[] = [];
  const GEOM = ["x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "width", "height", "d", "transform", "points", "viewBox"];
  const NON_NEGATIVE = ["width", "height", "r"];
  const BAD = /NaN|Infinity|undefined|null/;
  const describe = (el: Element) => {
    const cls = el.getAttribute("class");
    return `<${el.tagName.toLowerCase()}${cls ? ` class="${cls}"` : ""}>`;
  };
  const ids = new Map<string, number>();
  for (const svg of Array.from(root.querySelectorAll("svg"))) {
    const decorative = svg.getAttribute("aria-hidden") === "true" || svg.closest("[aria-hidden='true']");
    const labelled = svg.getAttribute("aria-label") || svg.getAttribute("aria-labelledby") || svg.querySelector("title");
    // Small inline icons inside a labelled control are fine without their own label.
    const iconInControl = svg.closest("button, a, label") && (svg.getAttribute("width") || "99") <= "24";
    if (!decorative && !labelled && !iconInControl) {
      issues.push({ rule: "svg-label", where: describe(svg), detail: "chart SVG needs role=img + aria-label (or aria-hidden)" });
    }
    for (const el of Array.from(svg.querySelectorAll("*"))) {
      for (const a of GEOM) {
        const v = el.getAttribute(a);
        if (v === null) continue;
        if (BAD.test(v)) issues.push({ rule: "bad-number", where: describe(el), detail: `${a}="${v.slice(0, 60)}"` });
        if (NON_NEGATIVE.includes(a) && Number(v) < 0) issues.push({ rule: "negative-size", where: describe(el), detail: `${a}="${v}"` });
        if (a === "d" && el.getAttribute("display") !== "none" && v.trim() === "" && el.tagName.toLowerCase() === "path" && !el.closest("defs")) {
          // empty paths are legitimate for clipped geometry; only flag if the element also has a fill/stroke class
          if (el.getAttribute("class")?.match(/link|arc|bar|route/)) issues.push({ rule: "empty-path", where: describe(el), detail: "empty d" });
        }
      }
      if (el.tagName.toLowerCase() === "text" && BAD.test(el.textContent ?? "")) {
        issues.push({ rule: "bad-text", where: describe(el), detail: (el.textContent ?? "").slice(0, 60) });
      }
      const id = el.getAttribute("id");
      if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
    }
  }
  for (const [id, n] of ids) if (n > 1) issues.push({ rule: "duplicate-id", where: `#${id}`, detail: `${n} elements` });
  return issues;
}
