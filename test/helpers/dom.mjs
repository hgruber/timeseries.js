// Minimal DOM stub so the library can be driven headlessly under `node --test`.
//
// timeseries.js touches a small, fixed surface: document.getElementById,
// canvas.getContext('2d'), getBoundingClientRect, window.getComputedStyle,
// ResizeObserver and Image. Stubbing those is enough to construct a real
// instance and dispatch synthetic mouse events at it, which is what lets the
// hit-test tests exercise the actual canvas.onmousemove → get_element path
// rather than a reimplementation of it.

const canvases = new Map();
const _origSetTimeout = globalThis.setTimeout;

function makeContext(canvas) {
  return new Proxy({}, {
    get(_t, k) {
      // Font metrics drive margin/axis sizing, so these must be plausible
      // numbers rather than undefined.
      if (k === 'measureText')
        return s => ({ width: 8 * String(s).length, actualBoundingBoxAscent: 9 });
      if (k === 'canvas') return canvas;
      if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (k === 'font' || k === 'fillStyle' || k === 'strokeStyle') return '';
      return () => {};      // every drawing call is a no-op
    },
    set() { return true; },
  });
}

// Fixed box for every stub element, so the tooltip's edge-flip arithmetic is
// deterministic rather than depending on a real layout engine.
export const ELEMENT_WIDTH = 120;
export const ELEMENT_HEIGHT = 34;

/**
 * A DOM element stub covering the surface the tooltip and legend overlays use:
 * className/style, appendChild/removeChild/replaceChildren, textContent
 * (recursive, so a test can assert on the rendered text) and offsetWidth/Height.
 *
 * The legend additionally needs a clickable/draggable surface the (pointer-inert)
 * tooltip never did: classList, dataset, setAttribute, addEventListener/emit and
 * offsetLeft/Top + getBoundingClientRect. `emit(type, ev)` invokes the
 * registered listeners so a test can drive a click or a drag directly.
 */
export function makeElement(tagName = 'div') {
  const attrs = new Map();
  const listeners = new Map();
  const classes = new Set();
  const el = {
    tagName: tagName.toUpperCase(),
    className: '',
    style: {},
    children: [],
    parentNode: null,
    innerHTML: '',
    dataset: {},
    offsetWidth: ELEMENT_WIDTH,
    offsetHeight: ELEMENT_HEIGHT,
    offsetLeft: 0,
    offsetTop: 0,
    _text: '',
    onclick: null,
    classList: {
      add: (...cs) => { for (const c of cs) classes.add(c); },
      remove: (...cs) => { for (const c of cs) classes.delete(c); },
      toggle: c => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
      contains: c => classes.has(c),
    },
    setAttribute: (k, v) => { attrs.set(k, String(v)); },
    getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: k => attrs.has(k),
    removeAttribute: k => { attrs.delete(k); },
    getBoundingClientRect: () => ({
      left: el.offsetLeft, top: el.offsetTop,
      width: el.offsetWidth, height: el.offsetHeight,
      right: el.offsetLeft + el.offsetWidth, bottom: el.offsetTop + el.offsetHeight,
    }),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const l = listeners.get(type);
      if (!l) return;
      const i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    },
    emit: (type, ev = {}) => {
      if (type === 'click' && typeof el.onclick === 'function') el.onclick(ev);
      for (const fn of listeners.get(type) || []) fn(ev);
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i !== -1) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    replaceChildren(...next) {
      for (const c of el.children) c.parentNode = null;
      el.children = [];
      el._text = '';
      el.innerHTML = '';
      for (const c of next) el.appendChild(c);
    },
    // Walk descendants matching a bare tag or `.class` selector — enough for the
    // legend's row lookups in tests.
    querySelectorAll(sel) {
      const out = [];
      const wantClass = sel[0] === '.' ? sel.slice(1) : null;
      const wantTag = wantClass ? null : sel.toUpperCase();
      (function walk(node) {
        for (const c of node.children) {
          if ((wantClass && (c.className || '').split(/\s+/).includes(wantClass)) ||
              (wantTag && c.tagName === wantTag)) out.push(c);
          walk(c);
        }
      })(el);
      return out;
    },
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      return el.children.length ? el.children.map(c => c.textContent).join('') : el._text;
    },
    set(v) {
      el.children = [];
      el._text = String(v);
    },
  });
  return el;
}

/**
 * Install the stubbed globals. Call once, before importing the library.
 */
export function installDOM() {
  const body = makeElement('body');
  // The legend attaches its drag move/up listeners to the document; give it the
  // same addEventListener/emit surface an element has so a test can drive a drag.
  const docListeners = new Map();
  globalThis.document = {
    body,
    getElementById: id => canvases.get(id) || null,
    createElement: tag => makeElement(tag),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const l = docListeners.get(type);
      if (!l) return;
      const i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    },
    emit: (type, ev = {}) => {
      for (const fn of docListeners.get(type) || []) fn(ev);
    },
  };
  globalThis.window = {
    // Viewport size: the tooltip clamps and flips against these.
    innerWidth: 1024,
    innerHeight: 768,
    getComputedStyle: () => ({
      font: '12px sans-serif', fontFamily: 'sans-serif', fontSize: '12px',
      color: '#000', backgroundColor: '#fff',
      paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
    }),
  };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.Image = class { set src(_v) {} };

  // A live TimeSeries instance keeps a self-rescheduling timer running
  // forever to advance the "now" line — correct for a browser tab, which the
  // user eventually closes, but under a Node test runner it would keep the
  // event loop (and the process) alive indefinitely. There is no public API
  // to fully halt it (ts.stop() only freezes follow mode, it doesn't cancel
  // the redraw timer), so every timer the library schedules is unref'd here:
  // it still fires normally, it just doesn't hold the process open once the
  // real test work is done.
  globalThis.setTimeout = function (...args) {
    var t = _origSetTimeout.apply(this, args);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
}

/**
 * Create a fresh stub canvas. Each test should use its own id — the library
 * refuses to attach twice to the same element.
 */
export function makeCanvas(id, width = 1000, height = 400) {
  // `attrs` plus the get/set/has trio is enough for the keyboard setup path,
  // which sets tabindex/role/aria-label — without them the library's guards
  // would skip that code entirely and it would go untested.
  const attrs = new Map();
  // addEventListener is what the tooltip overlay tracks the pointer with; the
  // library itself only assigns the on* properties. `emit` lets a test drive
  // those listeners directly.
  const listeners = new Map();
  const canvas = {
    clientWidth: width, clientHeight: height, width, height,
    style: {}, parentElement: null,
    attrs, listeners,
    getBoundingClientRect: () => ({
      left: 0, top: 0, width, height, right: width, bottom: height,
    }),
    setAttribute: (k, v) => { attrs.set(k, String(v)); },
    getAttribute: k => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: k => attrs.has(k),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const l = listeners.get(type);
      if (!l) return;
      const i = l.indexOf(fn);
      if (i !== -1) l.splice(i, 1);
    },
    emit: (type, ev) => {
      for (const fn of listeners.get(type) || []) fn(ev);
    },
  };
  canvas.getContext = () => makeContext(canvas);
  canvases.set(id, canvas);
  return canvas;
}

// Uses the captured, never-overridden setTimeout (ref'd) so a test's own
// wait reliably keeps the process alive — only the library's calls to the
// (later-overridden) global setTimeout get unref'd, see installDOM().
export const sleep = ms => new Promise(r => _origSetTimeout(r, ms));

/**
 * Apply a viewport and wait for it to settle.
 *
 * The 0 is zoom()'s duration argument: skip the animation and jump straight to
 * the target. The sleep still covers the redraw and the viewport-change
 * callback that follow it.
 */
export async function setView(ts, tmin, tmax) {
  ts.zoom(tmin, tmax, 0);
  await sleep(700);
}

/**
 * Rebuild the rctx a renderer receives, from the instance's public getters.
 * `ymax`/`ymin` are the axis extent the chart resolved to; for a span plot
 * that is 0…laneCount.
 */
export function makeRctx(ts, ymax, ymin = 0) {
  const area = ts.getPlotArea();
  const vp = ts.getViewport();
  return {
    X: t => ((t - vp.tmin) / (vp.tmax - vp.tmin)) * area.plotWidth + area.margin.left,
    Y: y => ((ymax - y) / (ymax - ymin)) * area.plotHeight + area.margin.top,
    ppv: area.plotHeight / (ymax - ymin),
    margin: area.margin,
    plotWidth: area.plotWidth,
    plotHeight: area.plotHeight,
  };
}
