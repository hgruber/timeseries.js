//////////////////////////////////////////////////////
// jpHomeAssistant.js                                //
// Standalone Home Assistant HTTP client — no deps   //
//////////////////////////////////////////////////////
//
// Usable independently of timeseries.js, like jpZabbix.js and caldav.js.
// Every public method returns a Promise. Errors reject with
// { code, data, message } — code 0 means the request never reached the
// server (network error or timeout).
//
//   var h = new jpHomeAssistant({ url: 'http://homeassistant.local:8123',
//                                   token: '…' });
//   h.history(['sensor.cpu', 'binary_sensor.door'], fromMs, toMs)
//       .then(byEntity => …);
//
// Home Assistant accepts only Bearer auth (a "long-lived access token" —
// the form they generate on the user's profile). `username`/`password` on
// the options are silently dropped, with a console.warn so a page
// misconfigured for Zabbix-style auth sees the warning instead of an
// opaque 401.
//
// CORS: a browser talking straight to Home Assistant needs that server
// to answer the preflight with GET in Access-Control-Allow-Methods and
// Authorization in Access-Control-Allow-Headers (a wildcard provably does
// not cover it). Auth travels in an explicit header rather than cookies
// (credentials: 'omit'), so a wildcard Access-Control-Allow-Origin is
// sufficient. Where none of that can be arranged, set `proxy` to a
// same-origin forwarder.

function fail(code, message, data) {
  return { code: code, message: message, data: data };
}

function authHeader(config) {
  var h = {};
  if (config.token != null) {
    h.Authorization = 'Bearer ' + config.token;
  } else if (config.username != null) {
    console.warn('jpHomeAssistant: Home Assistant does not support basic auth; token is required.');
  }
  if (config.headers) {
    for (var k in config.headers) {
      if (Object.prototype.hasOwnProperty.call(config.headers, k)) h[k] = config.headers[k];
    }
  }
  return h;
}

function endpoint(config, path) {
  if (config.proxy != null) return config.proxy + encodeURIComponent(new URL(path, config.url).toString());
  return new URL(path, config.url).toString();
}

function iso(ms) { return new Date(ms).toISOString(); }

/**
 * @param {{
 *   url?: string,
 *   token?: string,
 *   username?: string, password?: string,
 *   headers?: object,
 *   proxy?: string,
 *   timeout?: number,
 * }} options
 */
function jpHomeAssistant(options) {
  var config = {};
  Object.assign(config, {
    url: 'http://homeassistant.local:8123',
    token: null,
    username: null,
    password: null,
    headers: null,
    proxy: null,
    timeout: 20000,
  }, options);

  function request(method, path, body) {
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = (ctl && config.timeout != null)
      ? setTimeout(function () { ctl.abort(); }, config.timeout)
      : null;
    var headers = Object.assign({ Accept: 'application/json' }, authHeader(config));
    return fetch(endpoint(config, path), {
      method: method,
      headers: headers,
      body: body || undefined,
      signal: ctl && ctl.signal,
      credentials: 'omit',
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (res.status >= 400) {
        return res.json().then(function (json) {
          throw fail(res.status, 'home-assistant http ' + res.status, json);
        }, function () {
          throw fail(res.status, 'home-assistant http ' + res.status, null);
        });
      }
      return res.json();
    }, function (e) {
      if (timer) clearTimeout(timer);
      if (e && typeof e.code === 'number') throw e;
      var aborted = e && (e.name === 'AbortError' || /aborted/i.test(String(e && e.message)));
      throw fail(0, aborted
        ? 'home-assistant timeout after ' + config.timeout + 'ms for ' + path
        : 'home-assistant network error for ' + path + ': ' + (e && e.message), null);
    });
  }

  /**
   * History endpoint. Returns an array per requested entity — `[[entityHistory], …]`
   * — so the caller can route by entity. The order of the outer array matches
   * the order of `entityIds`.
   *
   * @param {string[]} entityIds
   * @param {number} fromMs
   * @param {number} toMs
   * @returns {Promise<Array<Array<{entity_id, state, last_changed, attributes}>>>}
   */
  this.history = function (entityIds, fromMs, toMs) {
    var qs = '/' + iso(fromMs) + '?end_time=' + encodeURIComponent(iso(toMs))
           + '&filter_entity_id=' + entityIds.map(encodeURIComponent).join(',');
    // We deliberately do NOT set minimal_response: the source needs
    // `attributes.unit_of_measurement` and `attributes.device_class` to
    // route numeric-vs-span correctly. Stripping them would force every
    // entity into the multiline path.
    return request('GET', '/api/history/period' + qs);
  };

  /**
   * Live state snapshot — used by the live demo's entity picker. Not used
   * by the built-in source.
   */
  this.states = function () { return request('GET', '/api/states'); };

  this.setOptions = function (o) {
    Object.assign(config, o || null);
    return Promise.resolve(true);
  };

  this.getConfig = function () {
    return Promise.resolve(Object.assign({}, config));
  };
}

// Parse the response from /api/history/period into a flat per-entity
// structure. The endpoint returns `[[{entity_id, state, last_changed,
// attributes: {unit_of_measurement, device_class}}, …], …]` — one inner
// array per requested entity. The order of the outer array is the order
// of `entityIds`, but Home Assistant's implementation only loosely honours
// that, so we re-key by `entity_id` for safety. Exported for testing.
export function parseHAHistory(json, entityIds) {
  var byId = Object.create(null);
  if (entityIds) for (var i = 0; i < entityIds.length; i++) byId[entityIds[i]] = [];
  if (!json || !Array.isArray(json)) return byId;
  for (var r = 0; r < json.length; r++) {
    var arr = json[r];
    if (!arr || !arr.length) continue;
    var id = arr[0].entity_id;
    if (id == null) continue;
    if (byId[id] == null) byId[id] = [];
    var cleaned = [];
    for (var k = 0; k < arr.length; k++) {
      var row = arr[k];
      var last = row.last_changed || row.last_updated;
      cleaned.push({
        entity_id: row.entity_id,
        state: row.state,
        last_changed: last,
        attributes: row.attributes || {},
      });
    }
    byId[id] = cleaned;
  }
  return byId;
}

export default jpHomeAssistant;