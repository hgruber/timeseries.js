// Data source plugin registry for timeseries.js
//
// Each source plugin: { type: string, init(source, callbacks) }
// callbacks shape:
//   pushData(plotObj) → plotId       push a new dataset, returns numeric ID
//   replaceData(id, plotObj)         swap dataset in-place (same ID)
//   removeData(id)                   remove a dataset
//   requestRedraw()                  trigger canvas redraw
//   getViewport() → {tmin,tmax,ppms} current visible range + pixel density
//   onViewportChange(fn)             register fn(tmin,tmax,ppms) called after pan/zoom settles

import jpZabbix from './jpZabbix.js';
import CalDAV from './caldav.js';
import jpPrometheus, { parsePromResponse } from './jpPrometheus.js';
import jpInfluxdb from './jpInfluxdb.js';
import jpHomeAssistant, { parseHAHistory } from './jpHomeAssistant.js';
import { isBandedType } from './renderers.js';

const registry = new Map();

/**
 * Register a data source plugin.
 * @param {{ type: string, init: function }} plugin
 */
export function registerSource(plugin) {
  registry.set(plugin.type, plugin);
}

/**
 * Initialize all sources, dispatching to registered plugins.
 */
export function initSources(sources, callbacks) {
  sources.forEach(function (source) {
    var plugin = registry.get(source['source-type']);
    if (plugin) plugin.init(source, callbacks);
    else console.warn('TimeSeries: unknown source-type', source['source-type']);
  });
}

// ── Built-in: artificial ──────────────────────────────────────────────────────

registerSource({
  type: 'artificial',
  init(source, callbacks) {
    callbacks.pushData(source);
  }
});

// ── Built-in: zabbix ─────────────────────────────────────────────────────────
//
// Zoom-adaptive Zabbix source. Two (or more) resolution tiers coexist as
// `quantile-bands` plots that differ only in `interval`: the core's
// prepare_grid picks the finest tier whose buckets are ≥ 2px per zoom and
// cross-fades the outgoing one at the boundary (see src/timeseries.js). Each
// tier is a self-managed ring cache — one replaceData block, bounded to
// ZBX_MAX_SLOTS, prefetching ±padding around the viewport like the CalDAV
// source below. Both `history` (raw, binned to min/avg/max per bucket) and
// `trends` (Zabbix's hourly value_min/avg/max) map to the SAME [min,avg,max]
// band shape, so history draws as a single line (min=avg=max at ~1 sample per
// bucket) and trends as a filled min/avg/max band, both via the shared
// quantile-bands renderer.
//
// Config keys:
//   url, username/password | auth-token   jpZabbix auth (token or login)
//   itemids            [itemid, …]         items to plot; each is a band series
//   value-type         history value type for history.get (0 float default,
//                      3 unsigned) — trends are numeric-only
//   history-interval   fine bucket seconds (default 60)
//   tiers              optional [{interval, kind:'history'|'trends'}] override
//   padding            prefetch fraction fetched either side (default 0.5)
//   series_colors      optional {itemid: cssColor}
//   name               optional plot name (coalesce/label key)
//
// After init `source.server` is the jpZabbix client and `source.refresh()`
// re-evaluates the current viewport (fetches only what isn't already covered).

var ZBX_MAX_SLOTS = 5000;   // per tier; ring-evicts the farthest-from-view slots
var ZBX_MIN_PX = 2;         // bucket width at/above which a tier is "the finest usable" — matches prepare_grid

// Finest tier index whose bucket width ≥ ZBX_MIN_PX, else the coarsest — the
// same rule prepare_grid uses to pick which interval renders, so what the
// source fetches and what the core draws never disagree. Exported for testing.
export function zabbixPrimaryTier(tiers, ppms) {
  for (var i = 0; i < tiers.length; i++)
    if (tiers[i].interval * 1000 * ppms >= ZBX_MIN_PX) return i;
  return tiers.length - 1;
}

// Padded prefetch window in ms, mirroring caldavWindow so ordinary panning is
// served from data already held.
export function zabbixWindow(viewport, padding) {
  var span = viewport.tmax - viewport.tmin;
  var pad = span * padding;
  return { from: viewport.tmin - pad, to: viewport.tmax + pad };
}

// Drop ring slots whose bucket falls inside [fromMs, toMs) so a re-fetch of that
// window replaces (never double-counts) its data, while slots from other
// windows the ring still holds survive — that is the multi-window cache.
export function zabbixClearRange(ring, interval, fromMs, toMs) {
  var lo = Math.floor(fromMs / 1000 / interval);
  var hi = Math.ceil(toMs / 1000 / interval);
  for (var slot of Array.from(ring.keys()))
    if (slot >= lo && slot < hi) ring.delete(slot);
}

// Fold Zabbix rows into a tier's ring. history rows are raw {itemid, clock,
// value}; trend rows carry value_min/value_avg/value_max. Both bin onto the
// tier's fixed `interval` grid; history accumulates min/max and a running mean
// within the bucket, trends drop straight in (one row per hour).
export function zabbixFold(ring, rows, interval, isTrend) {
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var slot = Math.floor(+row.clock / interval);
    var cell = ring.get(slot);
    if (!cell) { cell = {}; ring.set(slot, cell); }
    var id = row.itemid;
    var cur = cell[id];
    if (isTrend) {
      var mn = +row.value_min, av = +row.value_avg, mx = +row.value_max;
      if (!cur) cell[id] = { mn: mn, av: av, mx: mx, n: 1 };
      else {
        if (mn < cur.mn) cur.mn = mn;
        if (mx > cur.mx) cur.mx = mx;
        cur.av = av; cur.n = 1;
      }
    } else {
      var v = +row.value;
      if (!cur) cell[id] = { mn: v, av: v, mx: v, n: 1 };
      else {
        if (v < cur.mn) cur.mn = v;
        if (v > cur.mx) cur.mx = v;
        cur.n += 1;
        cur.av += (v - cur.av) / cur.n;   // running mean
      }
    }
  }
}

// Cap the ring at max slots, discarding those farthest from the viewport centre
// first — a session panning across a long range keeps recent neighbourhoods
// cached without growing without bound (guarded by test/… like memory.test).
export function zabbixEvict(ring, interval, centerMs, max) {
  if (ring.size <= max) return;
  var center = centerMs / 1000 / interval;
  var keys = Array.from(ring.keys());
  keys.sort(function (a, b) { return Math.abs(b - center) - Math.abs(a - center); });
  for (var i = 0; i < keys.length && ring.size > max; i++) ring.delete(keys[i]);
}

// Rebuild a ladder plot from a tier's ring. Slots are rebased onto the earliest
// held slot so plot.data keys start near 0, matching the binned shape the core
// expects. min=avg=max cells (history) render as a single line.
//
// `render` picks which of the ladder renderers draws it (the source's `render`
// option); a [min, avg, max] cell is equally a band, a step, an error bar or a
// candle. It must be the same for every tier of a signal — the cross-fade
// groups blocks by `plot.type`, so two types would pop instead of dissolving.
export function zabbixPlot(tier, ring, name, series_colors, render) {
  var plot = {
    type: render || 'quantile-bands',
    name: name,
    interval: tier.interval,
    interval_start: 0,
    interval_end: 0,
    percentiles: ['min', 'avg', 'max'],
    series_colors: series_colors || undefined,
    data: {},
    min: 0,
    max: 0,
  };
  if (!ring.size) return plot;
  var baseSlot = Infinity, maxSlot = -Infinity;
  for (var slot of ring.keys()) {
    if (slot < baseSlot) baseSlot = slot;
    if (slot > maxSlot) maxSlot = slot;
  }
  var mn = Infinity, mx = -Infinity;
  for (var entry of ring) {
    var cell = entry[1];
    var out = {};
    for (var id in cell) {
      var cc = cell[id];
      out[id] = [cc.mn, cc.av, cc.mx];
      if (cc.mn < mn) mn = cc.mn;
      if (cc.mx > mx) mx = cc.mx;
    }
    plot.data[entry[0] - baseSlot] = out;
  }
  plot.interval_start = baseSlot * tier.interval;
  plot.interval_end = (maxSlot + 1) * tier.interval;
  plot.min = mn === Infinity ? 0 : mn;
  plot.max = mx === -Infinity ? 0 : mx;
  return plot;
}

registerSource({
  type: 'zabbix',
  init(source, callbacks) {
    var tiers = (source['tiers'] && source['tiers'].length)
      ? source['tiers'].slice()
      : [{ interval: source['history-interval'] || 60, kind: 'history' },
         { interval: 3600, kind: 'trends' }];
    tiers.sort(function (a, b) { return a.interval - b.interval; });

    var padding = source['padding'] != null ? source['padding'] : 0.5;
    var valueType = source['value-type'] != null ? source['value-type'] : 0;
    var colors = source['series_colors'] || null;
    var name = source['name'] != null ? source['name']
      : String((source['itemids'] && source['itemids'][0]) || 'zabbix');
    // A [min, avg, max] cell suits any of the ladder renderers. Anything else
    // would be handed arrays it cannot read, so it falls back rather than
    // drawing nothing and leaving the reader to guess why.
    var render = source['render'] || 'quantile-bands';
    if (!isBandedType(render)) {
      console.warn('TimeSeries: zabbix render must be a ladder type, got', render);
      render = 'quantile-bands';
    }

    // Per-tier cache: ring of buckets, its chart slot id, the last window
    // fetched (fast-path skip) and a sequence guard against out-of-order XHRs.
    var state = tiers.map(function () {
      return { ring: new Map(), plotId: null, fetched: null, seq: 0 };
    });
    var server = null;

    // Tiers worth holding at this zoom: the primary (finest with buckets ≥ 2px,
    // via zabbixPrimaryTier), plus any whose buckets sit near the switch
    // threshold (so the cross-fade neighbour and the next zoom step are already
    // cached — no blank when the user crosses the boundary).
    function relevantTiers(ppms) {
      var prim = zabbixPrimaryTier(tiers, ppms);
      var rel = [];
      for (var i = 0; i < tiers.length; i++) {
        var px = tiers[i].interval * 1000 * ppms;
        if (i === prim || (px > ZBX_MIN_PX * 0.375 && px < ZBX_MIN_PX * 2)) rel.push(i);
      }
      return rel;
    }

    function fetchTier(i, viewport) {
      var st = state[i];
      var win = zabbixWindow(viewport, padding);
      // Free as long as the *viewport* still sits inside the padded window we
      // last fetched — that slack (±padding) is exactly what prefetching buys,
      // so ordinary panning costs nothing until the view nears the fetched edge.
      // (The ring may hold more than this window; that extra survives and keeps
      // rendering, it just isn't tracked for the skip decision.)
      if (st.fetched && viewport.tmin >= st.fetched.from && viewport.tmax <= st.fetched.to) return;
      var mine = ++st.seq;
      var trend = tiers[i].kind === 'trends';
      var params = {
        output: 'extend',
        itemids: source['itemids'],
        time_from: Math.floor(win.from / 1000),
        time_till: Math.ceil(win.to / 1000),
        sortfield: 'clock',
        sortorder: 'ASC',
      };
      if (!trend) params.history = valueType;
      server.api(trend ? 'trends.get' : 'history.get', params).then(function (rows) {
        // A newer request for this tier has superseded us.
        if (mine !== st.seq) return;
        st.fetched = win;
        zabbixClearRange(st.ring, tiers[i].interval, win.from, win.to);
        zabbixFold(st.ring, rows || [], tiers[i].interval, trend);
        zabbixEvict(st.ring, tiers[i].interval,
                    (viewport.tmin + viewport.tmax) / 2, ZBX_MAX_SLOTS);
        var plot = zabbixPlot(tiers[i], st.ring, name, colors, render);
        if (st.plotId === null) st.plotId = callbacks.pushData(plot);
        else callbacks.replaceData(st.plotId, plot);
        callbacks.requestRedraw();
      }, function (e) {
        if (mine === st.seq) console.warn('zabbix_failure', e);
      });
    }

    function refresh() {
      if (!server) return;
      var vp = callbacks.getViewport();
      var rel = relevantTiers(vp.ppms);
      for (var r = 0; r < rel.length; r++) fetchTier(rel[r], vp);
    }
    source.refresh = refresh;

    // Auth: an explicit token skips login; otherwise log in with user/password.
    function connect() {
      if (source['auth-token'] != null) {
        var s = new jpZabbix({ url: source['url'] });
        return s.setAuth(source['auth-token']).then(function () { return s; });
      }
      var srv = new jpZabbix({
        url: source['url'],
        user: source['username'],
        password: source['password'],
      });
      return srv.init().then(function () { return srv; });
    }

    connect().then(function (s) {
      server = s;
      source.server = server;
      refresh();
      callbacks.onViewportChange(function () { refresh(); });
    }, function (e) {
      console.warn('zabbix_failure', e);
    });
  }
});

// ── Built-in: caldav ─────────────────────────────────────────────────────────
//
// Fetches VEVENTs overlapping the viewport and hands them to the `gantt`
// renderer as a `category: 'span'` plot. Config keys:
//
//   url, username, password, auth-token, proxy   → see caldav.js
//   calendars   optional [href | {href,label,color}]; omitted → discover()
//   layout      'calendar' (default) | 'packed'
//   padding     extra window fetched either side, as a fraction of the
//               viewport width (default 0.5)
//
// After init, `source.client` is the CalDAV client and `source.setLayout(l)`
// switches layout without a refetch.

// Fetch a window wider than the viewport so ordinary panning is served from
// what we already have.
function caldavWindow(viewport, padding) {
  var span = viewport.tmax - viewport.tmin;
  var pad = span * padding;
  return { from: viewport.tmin - pad, to: viewport.tmax + pad };
}

function caldavPlot(results, from, to, layout) {
  var lanes = [];
  var events = [];
  for (var res of results) {
    if (res.error) console.warn('caldav_failure', res.calendar.href, res.error);
    lanes.push({
      id: res.calendar.href,
      label: res.calendar.label || res.calendar.displayName || res.calendar.href,
      color: res.calendar.color,
    });
    for (var ev of res.events)
      events.push({
        // Expanded recurrences all carry the master UID, so the start time is
        // what makes an instance identifiable.
        id: (ev.uid || '') + '@' + ev.start,
        lane: res.calendar.href,
        start: ev.start,
        end: ev.end,
        label: ev.summary,
        allDay: ev.allDay,
        location: ev.location,
        status: ev.status,
      });
  }
  return {
    type: 'gantt',
    category: 'span',
    tmin: from,
    tmax: to,
    layout: layout,
    lanes: lanes,
    data: events,
  };
}

registerSource({
  type: 'caldav',
  init(source, callbacks) {
    var clientOptions = {
      url: source['url'],
      username: source['username'],
      password: source['password'],
      token: source['auth-token'],
      proxy: source['proxy'],
    };
    // Set only when the caller actually asked for one. CalDAV's constructor
    // merges via Object.assign, which overwrites a default with a
    // present-but-undefined key — passing `timeout: source['timeout']`
    // unconditionally therefore replaced the 20 s default with `undefined`,
    // and `caldav.js`'s `ctl && config.timeout` then armed no abort timer at
    // all, so a server that never answers left the promise pending forever.
    if (source['timeout'] != null) clientOptions.timeout = source['timeout'];
    var client = new CalDAV(clientOptions);
    source.client = client;

    var layout = source['layout'] === 'packed' ? 'packed' : 'calendar';
    var padding = source['padding'] != null ? source['padding'] : 0.5;
    var calendars = null;
    var plotId = null;
    var current = null;   // the plot object currently in the chart
    var fetched = null;   // window currently held, in ms
    var seq = 0;          // guards against out-of-order responses

    function fetchWindow(viewport) {
      var win = caldavWindow(viewport, padding);
      // Already covered — panning inside the padded window costs nothing.
      if (fetched && win.from >= fetched.from && win.to <= fetched.to) return;
      var mine = ++seq;
      client.queryAll(calendars, win.from, win.to).then(function (results) {
        // A newer request has already been issued; this answer is for a window
        // the user has panned away from.
        if (mine !== seq) return;
        fetched = win;
        current = caldavPlot(results, win.from, win.to, layout);
        if (plotId === null) plotId = callbacks.pushData(current);
        else callbacks.replaceData(plotId, current);
        callbacks.requestRedraw();
      }, function (e) {
        if (mine === seq) console.warn('caldav_failure', e);
      });
    }

    function start(list) {
      calendars = list;
      if (!calendars.length) {
        console.warn('caldav: no calendars found at', source['url']);
        return;
      }
      fetchWindow(callbacks.getViewport());
      callbacks.onViewportChange(function () {
        fetchWindow(callbacks.getViewport());
      });
    }

    if (source['calendars'] && source['calendars'].length) {
      start(source['calendars'].map(function (cal) {
        return typeof cal === 'string' ? { href: cal, label: cal } : cal;
      }));
    } else {
      client.discover().then(start, function (e) {
        console.warn('caldav_failure', e);
      });
    }

    source.setLayout = function (next) {
      layout = next === 'packed' ? 'packed' : 'calendar';
      if (!current) return;
      // Row assignment is derived state — clearing the stamp is enough for
      // prepare_grid to repack on the next frame. No refetch needed.
      current.layout = layout;
      current._laidOut = null;
      callbacks.requestRedraw();
    };
  }
});

// ── Built-in: prometheus ─────────────────────────────────────────────────────
//
// Zoom-adaptive Prometheus source. Two resolution tiers (fine `step`, coarse
// `step * step-factor`) coexist as `multiline` blocks that differ only in
// `interval`. The core's `prepare_grid` cross-fades them at the switch, the
// same way it does for the Zabbix source. Below we explain only what is
// Prometheus-specific; the structural argument is in the Zabbix section
// above.
//
// Config keys:
//   url              Prometheus base URL (may be relative)
//   query            PromQL expression
//   token            Bearer token (preferred — revocable)
//   username, password
//                    HTTP basic fallback
//   headers          optional extra request headers — { 'X-Scope-OrgID': '…' }
//                    for Cortex/Mimir/Thanos tenants, or an explicit
//                    Authorization to override the computed one
//   proxy, timeout   see jpPrometheus.js (timeout is guarded below so the
//                    20 s default survives a present-but-undefined key)
//   step             fine-tier bucket seconds; auto-derived from ppms when
//                    omitted
//   step-factor      coarse-tier = step × step-factor (default 10)
//   padding          prefetch fraction either side (default 0.5)
//   render           'multiline' (default) | 'multipoint' | 'scatter'
//   series_colors    {<promSeriesKey>: cssColor}
//   name             plot name (defaults to the PromQL)
//
// After init `source.client` is the jpPrometheus instance and
// `source.refresh()` re-evaluates the current viewport.

var PROM_MIN_PX = 2;        // matches prepare_grid's bucket-width threshold

// Padded prefetch window — same shape as zabbixWindow / caldavWindow so
// ordinary panning inside ±padding is free. Exported for testing.
export function promWindow(viewport, padding) {
  var span = viewport.tmax - viewport.tmin;
  var pad = span * padding;
  return { from: viewport.tmin - pad, to: viewport.tmax + pad };
}

// Deterministic series key: the metric name plus its label pairs in a
// canonical order. Joined with \x1f so a label whose value contains `=`
// cannot collide with another label's name in the joined form. Two
// responses from the same PromQL yield the same ids, so a series that
// has been seen before is replaced, not duplicated. Exported for testing.
export function promSeriesKey(metric, labels) {
  var parts = [metric || ''];
  if (labels) {
    var keys = Object.keys(labels).sort();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === '__name__') continue;            // encoded into the metric part already
      parts.push(k + '=' + labels[k]);
    }
  }
  return parts.join('\x1f');
}

// Fold a Prometheus matrix result into a tier's array-of-points ring. The
// core's prepare_grid scans `category: 'point'` blocks as an iterable of
// `{t, values: {seriesKey: number}}` (see timeseries.js:2255), NOT as a
// slot map. Folding onto the tier's bucket grid first and rebuilding as a
// point array keeps the cached points aligned to the tier's resolution, so
// a return to the same zoom is served from the cache.
//
// `tierStepMs` is the tier's bucket width in ms; `dataStepMs` is the step
// the server actually returned. When they're equal we keep the raw values
// verbatim (one point per bucket); when the server returned finer data we
// aggregate each bucket to [mn, av, mx] and collapse to one point per bucket.
// Exported for testing.
export function promFold(ring, matrix, tierStepMs, dataStepMs) {
  var isBinned = dataStepMs != null && dataStepMs >= tierStepMs * 0.95;
  // First pass: bucket the matrix into a {slot → {key → accumulator}} ring.
  // We aggregate sub-bucket samples to [mn, av, mx] so the renderer's ladder
  // shape can collapse to a single line when all three are equal.
  var bucketRing = ring.bucketRing || (ring.bucketRing = new Map());
  for (var i = 0; i < matrix.length; i++) {
    var row = matrix[i];
    var key = promSeriesKey(row.metric && row.metric.__name__, row.metric);
    var values = row.values || [];
    for (var j = 0; j < values.length; j++) {
      var pair = values[j];
      var t = +pair[0];
      var v = +pair[1];
      var slot = Math.floor(t / tierStepMs);
      var cell = bucketRing.get(slot);
      if (!cell) { cell = {}; bucketRing.set(slot, cell); }
      var cur = cell[key];
      if (isBinned) {
        cell[key] = v;
      } else if (!cur) {
        cell[key] = { mn: v, av: v, mx: v, n: 1 };
      } else {
        if (v < cur.mn) cur.mn = v;
        if (v > cur.mx) cur.mx = v;
        // n must be incremented BEFORE the running-mean update — otherwise
        // the first sample's "running mean" is just v itself, and any
        // subsequent samples divide by the stale n and converge too fast.
        cur.n += 1;
        cur.av += (v - cur.av) / cur.n;
      }
    }
  }
  // Second pass: rebuild the point array. Order matches the bucket index so
  // the renderer's iteration is monotonic.
  ring.points = [];
  var min = Infinity, max = -Infinity;
  var keys = Array.from(bucketRing.keys()).sort(function (a, b) { return a - b; });
  for (var k = 0; k < keys.length; k++) {
    var slot2 = keys[k];
    var cell2 = bucketRing.get(slot2);
    var out = {};
    for (var ks in cell2) {
      var cc = cell2[ks];
      if (cc && typeof cc === 'object' && 'mn' in cc) {
        var mn2 = cc.mn, av2 = cc.av, mx2 = cc.mx;
        out[ks] = (mn2 === av2 && av2 === mx2) ? av2 : [mn2, av2, mx2];
        if (mn2 < min) min = mn2;
        if (mx2 > max) max = mx2;
      } else {
        out[ks] = cc;
        if (cc < min) min = cc;
        if (cc > max) max = cc;
      }
    }
    // Pin the point's t to the slot centre so a pan to a slightly different
    // viewport still hits the cached bucket.
    ring.points.push({ t: (slot2 + 0.5) * tierStepMs, values: out });
  }
  ring.min = min === Infinity ? 0 : min;
  ring.max = max === -Infinity ? 0 : max;
  return ring;
}

// Pick a step (seconds) such that the bucket width is at least PROM_MIN_PX
// at the current pixel density. A caller-supplied step wins; if it falls
// below the threshold we warn and use our own computation. Exported for
// testing.
export function promStepFor(ppms, plotWidth, requested) {
  // A step of 1 px per bucket is unusable; 2 px is the same threshold
  // prepare_grid uses. Convert ppms (px/ms) → ms per bucket, then to seconds.
  var stepMs = Math.max(1, Math.ceil(PROM_MIN_PX / ppms));
  if (requested != null) {
    var reqMs = requested * 1000;
    if (reqMs < stepMs) {
      console.warn('prometheus step', requested, 's is finer than 2 px/bucket at this zoom; using',
        Math.ceil(stepMs / 1000), 's');
      return Math.ceil(stepMs / 1000);
    }
    return requested;
  }
  return Math.max(1, Math.ceil(stepMs / 1000));
}

// Rebuild a multiline/multipoint/scatter plot from a tier's ring. The core
// expects `category: 'point'` blocks to carry `data` as an array of
// `{t, values}` points (see timeseries.js:2255); we built that in promFold
// and just hand it over. Slot-rebasing is unnecessary because the point
// timestamps are already absolute epoch ms.
//
// The block shape mirrors `zabbixPlot` for the binned fields — `interval`
// is in seconds (the core multiplies by 1000 itself when reading
// `interval_start`/`interval_end` on a binned block). For `category: 'point'`
// the core uses `tmin`/`tmax` instead (line 2191), which the source sets
// after each fetch. Exported for testing.
export function promPlot(tier, ring, name, series_colors, render) {
  var plot = {
    type: render || 'multiline',
    name: name,
    category: 'point',
    interval: tier.intervalMs / 1000,
    series_colors: series_colors || undefined,
    data: [],
    min: 0,
    max: 0,
  };
  if (!ring || !ring.points || !ring.points.length) return plot;
  plot.data = ring.points;
  plot.min = ring.min;
  plot.max = ring.max;
  return plot;
}

registerSource({
  type: 'prometheus',
  init(source, callbacks) {
    var padding = source['padding'] != null ? source['padding'] : 0.5;
    var stepFactor = source['step-factor'] != null ? source['step-factor'] : 10;
    var colors = source['series_colors'] || null;
    var name = source['name'] != null ? source['name'] : (source['query'] || 'prometheus');
    var render = source['render'] || 'multiline';
    // The renderers in this branch all read point data; reject others so a
    // typo doesn't render nothing.
    var pointRenderers = { multiline: 1, multipoint: 1, scatter: 1 };
    if (!pointRenderers[render]) {
      console.warn('prometheus render must be multiline|multipoint|scatter, got', render, '— falling back to multiline');
      render = 'multiline';
    }
    var query = source['query'];
    if (query == null) {
      console.warn('prometheus source missing `query`');
      return;
    }

    // Per-tier cache. The fine tier carries the source's intended resolution;
    // the coarse tier is `step * stepFactor` so the cross-fade into the
    // switch neighbour is already cached.
    var state = [
      { ring: {}, plotId: null, fetched: null, seq: 0, intervalMs: 0, factor: 1 },
      { ring: {}, plotId: null, fetched: null, seq: 0, intervalMs: 0, factor: stepFactor },
    ];
    var client = null;

    function tierFor(i) { return state[i]; }

    function fetchTier(i, viewport) {
      var st = tierFor(i);
      var stepSec = st.stepSec;        // resolved by refresh() before this runs
      var win = promWindow(viewport, padding);
      if (st.fetched && viewport.tmin >= st.fetched.from && viewport.tmax <= st.fetched.to) return;
      var mine = ++st.seq;
      client.queryRange(query, win.from, win.to, stepSec).then(function (envelope) {
        if (mine !== st.seq) return;             // superseded
        st.fetched = win;
        // Replace (never double-count) any buckets inside the window we just
        // fetched. Other held buckets survive — that is the cache.
        var lo = Math.floor(win.from / st.intervalMs);
        var hi = Math.ceil(win.to / st.intervalMs);
        var bucketRing = st.ring.bucketRing || new Map();
        for (var slot of Array.from(bucketRing.keys()))
          if (slot >= lo && slot < hi) bucketRing.delete(slot);
        st.ring.bucketRing = bucketRing;
        var matrix = parsePromResponse(envelope);
        promFold(st.ring, matrix, st.intervalMs, stepSec * 1000);
        var plot = promPlot({ intervalMs: st.intervalMs }, st.ring, name, colors, render);
        // The core's prepare_grid reads tmin/tmax for `category: 'point'`
        // blocks (line 2191 of timeseries.js), not interval_start/interval_end.
        // Without them the block never enters activePlot and stays invisible.
        plot.tmin = win.from;
        plot.tmax = win.to;
        if (st.plotId === null) st.plotId = callbacks.pushData(plot);
        else callbacks.replaceData(st.plotId, plot);
        callbacks.requestRedraw();
      }, function (e) {
        if (mine === st.seq) {
          // Empty PromQL result would surface as a 502 here if status was
          // 'error' — Prometheus itself returns success with result:[] when
          // the query is valid but no series match, and parsePromResponse
          // yields an empty array; the plot is then a graceful empty block.
          // We only warn for actual transport / server failures.
          console.warn('prometheus_failure', e);
        }
      });
    }

    function refresh() {
      if (!client) return;
      var vp = callbacks.getViewport();
      var stepSec = promStepFor(vp.ppms, null, source['step']);
      for (var i = 0; i < state.length; i++) {
        var s = state[i];
        s.stepSec = i === 0 ? stepSec : stepSec * s.factor;
        s.intervalMs = s.stepSec * 1000;
        fetchTier(i, vp);
      }
    }
    source.refresh = refresh;

    function auth() {
      var opts = { url: source['url'] };
      if (source['token'] != null) opts.token = source['token'];
      else if (source['username'] != null) {
        opts.username = source['username'];
        opts.password = source['password'];
      }
      if (source['headers']) opts.headers = source['headers'];
      if (source['proxy'] != null) opts.proxy = source['proxy'];
      // Guarded merge: caldav.js' documented trap — Object.assign overwrites
      // defaults with a present-but-undefined key, so only forward `timeout`
      // when the caller actually set it.
      if (source['timeout'] != null) opts.timeout = source['timeout'];
      client = new jpPrometheus(opts);
      source.client = client;
      source.server = client;
    }

    auth();
    refresh();
    callbacks.onViewportChange(refresh);
  }
});

// ── Built-in: influxdb ───────────────────────────────────────────────────────
//
// Two-API InfluxDB source. `mode: '1x'` (InfluxQL, POST /query,
// form-encoded) and `mode: '2x'` (Flux, POST /api/v2/query, JSON) are
// served by one client that returns a normalised { series } envelope; the
// source folds that into `category: 'point'` blocks the same way Prometheus
// does. The two-tier ladder (fine `step` + coarse `step * step-factor`) and
// the padded window are inherited unchanged from the Prometheus source; the
// core's prepare_grid cross-fades them at the switch, exactly as for Zabbix
// and Prometheus.
//
// Config keys:
//   url              InfluxDB base URL
//   mode             '1x' (default) | '2x'
//   db               mode 1x: database name (required for the query body)
//   org              mode 2x: organisation
//   bucket           mode 2x: bucket (caller embeds it in the Flux query)
//   token            preferred auth — `Authorization: Token …`
//   username, password
//                    HTTP basic fallback (mode 1x only — 2x accepts tokens
//                    only and the client drops basic silently there)
//   headers          optional extra request headers
//   proxy, timeout   see jpInfluxdb.js (timeout is guarded below)
//   query            full InfluxQL or Flux query
//   step             fine-tier bucket seconds; auto-derived from ppms
//   step-factor      coarse-tier = step × step-factor (default 10)
//   padding          prefetch fraction either side (default 0.5)
//   render           'multiline' (default) | 'multipoint' | 'quantile-bands'
//   series_colors    {<influxSeriesKey>: cssColor}
//   name             plot name
//
// After init `source.client` is the jpInfluxdb instance and
// `source.refresh()` re-evaluates the current viewport.

var INFLUX_MIN_PX = 2;

export function influxWindow(viewport, padding) {
  var span = viewport.tmax - viewport.tmin;
  var pad = span * padding;
  return { from: viewport.tmin - pad, to: viewport.tmax + pad };
}

// Deterministic series key. Two responses with the same InfluxQL/Flux and
// the same tag set yield the same id, so a series that has been seen before
// is replaced, not duplicated. Joined with \x1f so a tag whose value
// contains `=` cannot collide with another tag's name. Exported for testing.
export function influxSeriesKey(name, tags) {
  var parts = [name || ''];
  if (tags) {
    var keys = Object.keys(tags).sort();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'time' || k === 'table') continue;
      parts.push(k + '=' + tags[k]);
    }
  }
  return parts.join('\x1f');
}

// Fold a normalised { series: [{ name, tags, points: [[t, v], …] }] }
// envelope into a tier's bucket ring. Sub-bucket samples aggregate to
// [mn, av, mx]; already-binned samples (a `mean()` per bucket, where the
// raw cadence equals the bucket width) collapse to a scalar. Exported.
export function influxFold(ring, envelope, tierStepMs, dataStepMs) {
  var isBinned = dataStepMs != null && dataStepMs >= tierStepMs * 0.95;
  var bucketRing = ring.bucketRing || (ring.bucketRing = new Map());
  var series = envelope.series || [];
  for (var i = 0; i < series.length; i++) {
    var s = series[i];
    var key = influxSeriesKey(s.name, s.tags);
    var pts = s.points || [];
    for (var j = 0; j < pts.length; j++) {
      var pair = pts[j];
      var t = +pair[0];
      var v = +pair[1];
      if (v !== v) continue;             // skip NaN
      var slot = Math.floor(t / tierStepMs);
      var cell = bucketRing.get(slot);
      if (!cell) { cell = {}; bucketRing.set(slot, cell); }
      var cur = cell[key];
      if (isBinned) {
        cell[key] = v;
      } else if (!cur) {
        cell[key] = { mn: v, av: v, mx: v, n: 1 };
      } else {
        if (v < cur.mn) cur.mn = v;
        if (v > cur.mx) cur.mx = v;
        cur.n += 1;
        cur.av += (v - cur.av) / cur.n;
      }
    }
  }
  ring.points = [];
  var min = Infinity, max = -Infinity;
  var keys = Array.from(bucketRing.keys()).sort(function (a, b) { return a - b; });
  for (var k = 0; k < keys.length; k++) {
    var slot2 = keys[k];
    var cell2 = bucketRing.get(slot2);
    var out = {};
    for (var ks in cell2) {
      var cc = cell2[ks];
      if (cc && typeof cc === 'object' && 'mn' in cc) {
        var mn2 = cc.mn, av2 = cc.av, mx2 = cc.mx;
        out[ks] = (mn2 === av2 && av2 === mx2) ? av2 : [mn2, av2, mx2];
        if (mn2 < min) min = mn2;
        if (mx2 > max) max = mx2;
      } else {
        out[ks] = cc;
        if (cc < min) min = cc;
        if (cc > max) max = cc;
      }
    }
    ring.points.push({ t: (slot2 + 0.5) * tierStepMs, values: out });
  }
  ring.min = min === Infinity ? 0 : min;
  ring.max = max === -Infinity ? 0 : max;
  return ring;
}

export function influxStepFor(ppms, plotWidth, requested) {
  var stepMs = Math.max(1, Math.ceil(INFLUX_MIN_PX / ppms));
  if (requested != null) {
    var reqMs = requested * 1000;
    if (reqMs < stepMs) {
      console.warn('influxdb step', requested, 's is finer than 2 px/bucket at this zoom; using',
        Math.ceil(stepMs / 1000), 's');
      return Math.ceil(stepMs / 1000);
    }
    return requested;
  }
  return Math.max(1, Math.ceil(stepMs / 1000));
}

export function influxPlot(tier, ring, name, series_colors, render) {
  var plot = {
    type: render || 'multiline',
    name: name,
    category: 'point',
    interval: tier.intervalMs / 1000,
    series_colors: series_colors || undefined,
    data: [],
    min: 0,
    max: 0,
  };
  if (!ring || !ring.points || !ring.points.length) return plot;
  plot.data = ring.points;
  plot.min = ring.min;
  plot.max = ring.max;
  return plot;
}

registerSource({
  type: 'influxdb',
  init(source, callbacks) {
    var padding = source['padding'] != null ? source['padding'] : 0.5;
    var stepFactor = source['step-factor'] != null ? source['step-factor'] : 10;
    var colors = source['series_colors'] || null;
    var name = source['name'] != null ? source['name'] : (source['query'] || 'influxdb');
    var render = source['render'] || 'multiline';
    var pointRenderers = { multiline: 1, multipoint: 1, 'quantile-bands': 1 };
    if (!pointRenderers[render]) {
      console.warn('influxdb render must be multiline|multipoint|quantile-bands, got', render, '— falling back to multiline');
      render = 'multiline';
    }
    var query = source['query'];
    if (query == null) {
      console.warn('influxdb source missing `query`');
      return;
    }

    var state = [
      { ring: {}, plotId: null, fetched: null, seq: 0, intervalMs: 0, factor: 1 },
      { ring: {}, plotId: null, fetched: null, seq: 0, intervalMs: 0, factor: stepFactor },
    ];
    var client = null;

    function fetchTier(i, viewport) {
      var st = state[i];
      var stepSec = st.stepSec;
      var win = influxWindow(viewport, padding);
      if (st.fetched && viewport.tmin >= st.fetched.from && viewport.tmax <= st.fetched.to) return;
      var mine = ++st.seq;
      client.query(query, win.from, win.to).then(function (envelope) {
        if (mine !== st.seq) return;
        st.fetched = win;
        var lo = Math.floor(win.from / st.intervalMs);
        var hi = Math.ceil(win.to / st.intervalMs);
        var bucketRing = st.ring.bucketRing || new Map();
        for (var slot of Array.from(bucketRing.keys()))
          if (slot >= lo && slot < hi) bucketRing.delete(slot);
        st.ring.bucketRing = bucketRing;
        influxFold(st.ring, envelope, st.intervalMs, stepSec * 1000);
        var plot = influxPlot({ intervalMs: st.intervalMs }, st.ring, name, colors, render);
        plot.tmin = win.from;
        plot.tmax = win.to;
        if (st.plotId === null) st.plotId = callbacks.pushData(plot);
        else callbacks.replaceData(st.plotId, plot);
        callbacks.requestRedraw();
      }, function (e) {
        if (mine === st.seq) console.warn('influxdb_failure', e);
      });
    }

    function refresh() {
      if (!client) return;
      var vp = callbacks.getViewport();
      var stepSec = influxStepFor(vp.ppms, null, source['step']);
      for (var i = 0; i < state.length; i++) {
        var s = state[i];
        s.stepSec = i === 0 ? stepSec : stepSec * s.factor;
        s.intervalMs = s.stepSec * 1000;
        fetchTier(i, vp);
      }
    }
    source.refresh = refresh;

    function auth() {
      var opts = { url: source['url'] };
      if (source['mode'] != null) opts.mode = source['mode'];
      if (source['db'])     opts.db = source['db'];
      if (source['org'])    opts.org = source['org'];
      if (source['bucket']) opts.bucket = source['bucket'];
      if (source['token'] != null) opts.token = source['token'];
      else if (source['username'] != null) {
        opts.username = source['username'];
        opts.password = source['password'];
      }
      if (source['headers']) opts.headers = source['headers'];
      if (source['proxy'] != null) opts.proxy = source['proxy'];
      if (source['timeout'] != null) opts.timeout = source['timeout'];
      client = new jpInfluxdb(opts);
      source.client = client;
      source.server = client;
    }

    auth();
    refresh();
    callbacks.onViewportChange(refresh);
  }
});

// ── Built-in: home-assistant ─────────────────────────────────────────────────
//
// Home Assistant returns mixed-shape data: numeric sensors (temperature,
// power, …) belong to `category: 'point'` with a multiline renderer, while
// binary/state sensors (door, motion, occupancy) belong to `category: 'span'`
// with the gantt renderer. The source decides per-entity which shape to use
// and pushes one block per entity, so a single chart can carry both kinds
// side-by-side (or split across two charts — the renderer is per block).
//
// Config keys:
//   url              Home Assistant base URL
//   token            Bearer token (long-lived access token); the only auth HA
//                    accepts — basic is silently dropped with a warning
//   entity-ids       ['sensor.cpu', 'binary_sensor.door', …]
//   padding          prefetch fraction either side (default 0.5)
//   render           per-entity override (numeric default 'multiline', binary
//                    default 'gantt'); can be overridden via 'force-render'
//                    for testing or for entities that mis-classify
//   series_colors    {<entity_id>: cssColor}
//   name             plot name (defaults to 'Home Assistant')
//   proxy, timeout   see jpHomeAssistant.js (timeout is guarded below)
//
// After init `source.client` is the jpHomeAssistant instance and
// `source.refresh()` re-evaluates the current viewport.

export function haWindow(viewport, padding) {
  var span = viewport.tmax - viewport.tmin;
  var pad = span * padding;
  return { from: viewport.tmin - pad, to: viewport.tmax + pad };
}

// Decide whether an entity is numeric (→ multiline) or span (→ gantt).
// Numeric wins whenever the state parses as a finite number, so a numeric
// sensor with a missing `unit_of_measurement` still routes correctly. A
// state of 'unavailable' / 'unknown' / 'none' is span (it's a non-numeric
// sentinel, and the gantt renderer draws it as a label, not a marker).
// Exported for testing.
export function inferHaRenderType(entityId, lastState, attributes) {
  if (lastState == null) return 'span';
  var s = String(lastState);
  if (s === 'unavailable' || s === 'unknown' || s === 'none' || s === '') return 'span';
  if (s === 'on' || s === 'off') return 'span';
  var n = +s;
  if (n === n) return 'numeric';
  return 'span';
}

// Fold a Home Assistant history array for ONE entity into the multiline
// shape the renderer expects: a sorted list of {t, values: {<entity_id>: <number>}}.
export function haFoldNumeric(entityId, states, fromMs, toMs) {
  var out = [];
  for (var i = 0; i < states.length; i++) {
    var row = states[i];
    if (!row) continue;
    var t = Date.parse(row.last_changed);
    if (isNaN(t) || t < fromMs || t > toMs) continue;
    var n = +row.state;
    if (n !== n) continue;
    var slot = {}; slot[entityId] = n;
    out.push({ t: t, values: slot });
  }
  out.sort(function (a, b) { return a.t - b.t; });
  return out;
}

// Fold a history array for one entity into the span shape: one span per
// state interval, with `end` falling on the next state's `last_changed`
// (open-ended spans — the most recent state — get `end = max(toMs, now)`).
export function haFoldSpan(entityId, states, fromMs, toMs) {
  var spans = [];
  var lastChange = null;
  var lastState = null;
  for (var i = 0; i < states.length; i++) {
    var row = states[i];
    if (!row) continue;
    var t = Date.parse(row.last_changed);
    if (isNaN(t) || t > toMs) continue;
    if (t < fromMs) {
      // The state was already in effect at the window's left edge — start
      // there instead of at the actual last_changed.
      lastChange = fromMs;
      lastState = row.state;
      continue;
    }
    if (lastChange != null) {
      spans.push({
        id: entityId + '@' + lastChange,
        lane: entityId,
        start: lastChange,
        end: t,
        label: lastState,
        allDay: false,
      });
    }
    lastChange = t;
    lastState = row.state;
  }
  if (lastChange != null) {
    // Open-ended — the sensor is still in `lastState` at the right edge of
    // the window. Use max(toMs, now) so a slow refresh doesn't show the
    // span ending at the edge of the cached window.
    var endMs = Math.max(toMs, Date.now());
    spans.push({
      id: entityId + '@' + lastChange,
      lane: entityId,
      start: lastChange,
      end: endMs,
      label: lastState,
      allDay: false,
    });
  }
  return spans;
}

registerSource({
  type: 'home-assistant',
  init(source, callbacks) {
    var padding = source['padding'] != null ? source['padding'] : 0.5;
    var colors = source['series_colors'] || null;
    var name = source['name'] != null ? source['name'] : 'Home Assistant';
    var entityIds = source['entity-ids'] || [];
    if (!entityIds.length) {
      console.warn('home-assistant source missing `entity-ids`');
      return;
    }

    // One plot per entity, keyed by entity_id. plotId=null means "not yet
    // pushed"; a numeric block uses pushData/replaceData, the gantt uses the
    // same pattern (replaceData swaps the whole `data` array).
    var plots = Object.create(null);
    entityIds.forEach(function (e) {
      plots[e] = { plotId: null, renderType: null, lastState: null, lastAttributes: null, states: null };
    });
    var client = null;
    var entitySeq = 0;
    // Largest window the source has fetched so far. Re-keyed by entity so a
    // pan that widens either edge triggers a single re-fetch per crossing.
    // `byId` is the raw parseHAHistory envelope for that window.
    var fetched = Object.create(null);   // eid → { from, to, states }

    function buildNumericPlot(entityId, points, win) {
      var colorMap;
      if (colors) { colorMap = {}; colorMap[entityId] = colors[entityId]; }
      return {
        type: 'multiline',
        name: name + ' · ' + entityId,
        category: 'point',
        data: points,
        min: 0, max: 0,
        tmin: win.from, tmax: win.to,
        series_colors: colorMap,
      };
    }
    function buildSpanPlot(entityId, spans, win) {
      return {
        type: 'gantt',
        name: name + ' · ' + entityId,
        category: 'span',
        lanes: [{ id: entityId, label: entityId, color: colors && colors[entityId] }],
        data: spans,
        tmin: win.from, tmax: win.to,
      };
    }

    function applyStates(byId, win) {
      for (var i = 0; i < entityIds.length; i++) {
        var eid = entityIds[i];
        var st = plots[eid];
        if (!st) continue;
        var states = byId[eid] || [];
        var lastState = states.length ? states[states.length - 1].state : null;
        var lastAttrs = states.length ? states[states.length - 1].attributes : null;
        var renderType = inferHaRenderType(eid, lastState, lastAttrs);
        var plot;
        if (renderType === 'numeric') {
          var points = haFoldNumeric(eid, states, win.from, win.to);
          plot = buildNumericPlot(eid, points, win);
        } else {
          var spans = haFoldSpan(eid, states, win.from, win.to);
          plot = buildSpanPlot(eid, spans, win);
        }
        // Switch between numeric and span when the routing decision
        // changes for an entity — old plotId becomes invalid, so we
        // release it via removeData and push the new one.
        if (st.renderType && st.renderType !== renderType && st.plotId != null) {
          callbacks.removeData(st.plotId);
          st.plotId = null;
        }
        if (st.plotId == null) st.plotId = callbacks.pushData(plot);
        else callbacks.replaceData(st.plotId, plot);
        st.renderType = renderType;
        st.lastState = lastState;
        st.lastAttributes = lastAttrs;
        st.states = states;
      }
      callbacks.requestRedraw();
    }

    function refresh() {
      if (!client) return;
      var vp = callbacks.getViewport();
      var win = haWindow(vp, padding);
      // Padded-window skip with growing cache: per-entity, the source has
      // already fetched a window that fully covers [win.from, win.to] iff
      // every entity's cached [from, to] contains both edges. Otherwise
      // refetch the union (capped at the existing fetched edges so the
      // server is never asked to re-send overlapping history).
      var needFrom = win.from, needTo = win.to;
      for (var i = 0; i < entityIds.length; i++) {
        var f = fetched[entityIds[i]];
        if (!f) continue;
        if (f.from <= win.from && f.to >= win.to) continue;
        if (f.from < needFrom) needFrom = f.from;
        if (f.to   > needTo)   needTo   = f.to;
      }
      var allCovered = true;
      for (var j = 0; j < entityIds.length; j++) {
        var fe = fetched[entityIds[j]];
        if (!fe || fe.from > win.from || fe.to < win.to) { allCovered = false; break; }
      }
      if (allCovered) {
        // Replay from cache: each entity's states are still valid for the
        // narrower window; the helpers clip them to [win.from, win.to].
        var cached = Object.create(null);
        for (var k = 0; k < entityIds.length; k++) {
          cached[entityIds[k]] = (fetched[entityIds[k]] && fetched[entityIds[k]].states) || [];
        }
        applyStates(cached, win);
        return;
      }
      var mine = ++entitySeq;
      client.history(entityIds, needFrom, needTo).then(function (resp) {
        if (mine !== entitySeq) return;
        var byId = parseHAHistory(resp, entityIds);
        for (var m = 0; m < entityIds.length; m++) {
          var eid = entityIds[m];
          var states = byId[eid] || [];
          // Merge with previously cached states (sorted, deduped by
          // last_changed) so the widened window does not lose older rows.
          var prev = fetched[eid];
          if (prev && prev.states && prev.states.length) {
            var seen = Object.create(null);
            var merged = [];
            for (var p = 0; p < prev.states.length; p++) {
              var pk = prev.states[p].last_changed;
              if (seen[pk]) continue;
              seen[pk] = true;
              merged.push(prev.states[p]);
            }
            for (var q = 0; q < states.length; q++) {
              var kk = states[q].last_changed;
              if (seen[kk]) continue;
              seen[kk] = true;
              merged.push(states[q]);
            }
            merged.sort(function (a, b) { return Date.parse(a.last_changed) - Date.parse(b.last_changed); });
            states = merged;
          }
          fetched[eid] = {
            from: Math.min(needFrom, prev ? prev.from : needFrom),
            to:   Math.max(needTo,   prev ? prev.to   : needTo),
            states: states,
          };
        }
        applyStates(byId, win);
      }, function (e) {
        if (mine === entitySeq) console.warn('home-assistant_failure', e);
      });
    }
    source.refresh = refresh;

    function auth() {
      var opts = { url: source['url'] };
      if (source['token'] != null) opts.token = source['token'];
      else if (source['username'] != null) {
        opts.username = source['username'];
        opts.password = source['password'];
      }
      if (source['headers']) opts.headers = source['headers'];
      if (source['proxy'] != null) opts.proxy = source['proxy'];
      if (source['timeout'] != null) opts.timeout = source['timeout'];
      client = new jpHomeAssistant(opts);
      source.client = client;
      source.server = client;
    }

    auth();
    refresh();
    callbacks.onViewportChange(refresh);
  }
});
