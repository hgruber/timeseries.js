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
