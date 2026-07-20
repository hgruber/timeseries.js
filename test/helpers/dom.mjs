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

/**
 * Install the stubbed globals. Call once, before importing the library.
 */
export function installDOM() {
  globalThis.document = { getElementById: id => canvases.get(id) || null };
  globalThis.window = {
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
  const canvas = {
    clientWidth: width, clientHeight: height, width, height,
    style: {}, parentElement: null,
    getBoundingClientRect: () => ({
      left: 0, top: 0, width, height, right: width, bottom: height,
    }),
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
