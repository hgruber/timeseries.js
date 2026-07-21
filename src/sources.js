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

function sumValues(obj) {
  return Object.keys(obj).reduce(
    (sum, key) => sum + parseFloat(obj[key] || 0),
    0,
  );
}

function onZabbixData(source, opt, d, callbacks) {
  var tmp = {
    name: d[0].itemid,
    type: source["plot-type"],
    itemids: opt["itemids"],
    interval_start: opt.time_from,
    interval_end: opt.time_till,
    interval:
      ((opt.time_till - opt.time_from) / d.length) * opt["itemids"].length,
    count: Math.round(d.length / opt["itemids"].length),
    min: 0,
    max: d[0].value,
  };
  var result = [];
  d.forEach((item) => {
    var idx = Math.floor((item.clock - tmp.interval_start) / tmp.interval);
    tmp.min = Math.min(tmp.min, item.value);
    tmp.max = Math.max(tmp.max, item.value);
    if (result[idx] == null) {
      result[idx] = { [item.itemid]: parseFloat(item.value) };
    } else {
      result[idx][item.itemid] = parseFloat(item.value);
    }
  });
  if (source["plot-type"] === "multibar")
    for (const i of Object.keys(result)) {
      var sv = sumValues(result[i]);
      if (tmp.max < sv) tmp.max = sv;
    }
  tmp.data = result;
  callbacks.pushData(tmp);
  callbacks.requestRedraw();
}

registerSource({
  type: 'zabbix',
  init(source, callbacks) {
    var server;
    if (source["auth-token"] != null) {
      server = new jpZabbix({ url: source["url"], auth: source["auth-token"] });
    } else {
      server = new jpZabbix({
        url: source["url"],
        username: source["username"],
        password: source["password"],
      });
    }

    function authSuccess() {
      var viewport = callbacks.getViewport();
      var options = {
        itemids: source["itemids"],
        time_from: Math.floor(viewport.tmin / 1000),
        time_till: Math.ceil(viewport.tmax / 1000),
      };
      server.api("history.get", options).then(
        (d) => onZabbixData(source, options, d, callbacks),
        (e) => { console.warn("zabbix_failure", e); },
      );
    }

    server
      .setAuth(source["auth-token"])
      .then(authSuccess, (e) => { console.warn("zabbix_failure", e); });
    source.server = server;
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
    var client = new CalDAV({
      url: source['url'],
      username: source['username'],
      password: source['password'],
      token: source['auth-token'],
      proxy: source['proxy'],
      timeout: source['timeout'],
    });
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
