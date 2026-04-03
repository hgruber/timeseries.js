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
    if (result[idx] == undefined) {
      result[idx] = { [item.itemid]: parseFloat(item.value) };
    } else {
      result[idx][item.itemid] = parseFloat(item.value);
    }
  });
  if (source["plot-type"] == "multibar")
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
    if (source["auth-token"] != undefined) {
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
