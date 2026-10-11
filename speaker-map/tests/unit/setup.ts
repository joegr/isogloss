// jsdom lacks layout and a few browser APIs d3 and our modules touch.
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = RO;
window.matchMedia = window.matchMedia || ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }) as any);
document.body.insertAdjacentHTML("beforeend", '<div class="tooltip" id="tooltip" hidden></div>');
