//////////////////////////////////////////////////////
// jpPrometheus.js                                   //
// Standalone Prometheus HTTP client — no dependencies//
//////////////////////////////////////////////////////
//
// Usable independently of timeseries.js, like jpZabbix.js and caldav.js.
// Every public method returns a Promise. Errors reject with
// { code, data, message } — code 0 means the request never reached the
// server (network error or timeout).
//
//   var p = new jpPrometheus({ url: 'http://localhost:9090', token: '…' });
//   p.queryRange('up', fromMs, toMs, 30).then(envelope => …);
//
// The same HTTP shape covers Prometheus, VictoriaMetrics, Thanos, Cortex
// and Grafana Mimir — they all implement /api/v1/query_range for drop-in
// compatibility, so one client covers the CNCF metrics family.
//
// CORS: a browser talking straight to Prometheus needs that server to
// answer the preflight with GET in Access-Control-Allow-Methods and
// Authorization in Access-Control-Allow-Headers (a wildcard provably
// does not cover it). Auth travels in an explicit header rather than
// cookies (credentials: 'omit'), so a wildcard Access-Control-Allow-Origin
// is sufficient. Where none of that can be arranged, set `proxy` to a
// same-origin forwarder.

function fail(code, message, data) {
  return { code: code, message: message, data: data };
}

// Build the auth header according to the documented precedence:
// token (Authorization: Bearer) wins; basic auth (user+password) is the
// fallback; a caller-supplied `headers.Authorization` overrides both (a
// proxy or gateway token sits there). Headers other than Authorization
// are merged on top.
function authHeader(config) {
  var h = {};
  if (config.token != null) {
    h.Authorization = 'Bearer ' + config.token;
  } else if (config.username != null) {
    // btoa is a global on every browser. Username/password with non-ASCII
    // characters are the caller's problem; Prometheus only ever accepts
    // ASCII for HTTP basic.
    h.Authorization = 'Basic ' + btoa(config.username + ':' + (config.password || ''));
  }
  if (config.headers) {
    for (var k in config.headers) {
      if (Object.prototype.hasOwnProperty.call(config.headers, k)) h[k] = config.headers[k];
    }
  }
  return h;
}

// Build an absolute URL via `proxy` if set, otherwise hand the path back
// resolved against the configured base. Mirrors caldav.js' `endpoint` so
// the same forwarder shape (`?url=…` style) works for every source.
function endpoint(config, path) {
  if (config.proxy != null) return config.proxy + encodeURIComponent(new URL(path, config.url).toString());
  // URL.resolve accepts a path like '/api/v1/query_range' against any base.
  return new URL(path, config.url).toString();
}

/**
 * @param {{
 *   url?: string,
 *   token?: string,
 *   username?: string,
 *   password?: string,
 *   headers?: object,
 *   proxy?: string,
 *   timeout?: number,
 * }} options
 */
function jpPrometheus(options) {
  var config = {};
  Object.assign(config, {
    url: 'http://localhost:9090',
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
      // Prometheus /api/v1/* envelopes carry `status: success|error`. A
      // 200 with status:'error' is a server-side failure (bad PromQL,
      // timed-out evaluation, …) and must reject so the source can
      // decide whether to fall back to an empty block.
      return res.json().then(function (json) {
        if (res.status >= 400) {
          throw fail(res.status, 'prometheus http ' + res.status, json);
        }
        if (json && json.status && json.status !== 'success') {
          throw fail(502, 'prometheus: ' + json.status, json.errorType || json.data);
        }
        return json;
      }, function () {
        throw fail(res.status, 'prometheus http ' + res.status + ' (no body)', null);
      });
    }, function (e) {
      if (timer) clearTimeout(timer);
      if (e && typeof e.code === 'number') throw e;
      var aborted = e && (e.name === 'AbortError' || /aborted/i.test(String(e && e.message)));
      throw fail(0, aborted
        ? 'prometheus timeout after ' + config.timeout + 'ms for ' + path
        : 'prometheus network error for ' + path + ': ' + (e && e.message), null);
    });
  }

  /**
   * Range query against /api/v1/query_range. Returns the raw envelope;
   * the source does the folding.
   *
   * @param {string} query  PromQL expression
   * @param {number} fromMs window start (epoch ms, inclusive)
   * @param {number} toMs   window end (epoch ms, exclusive)
   * @param {number} stepSec step in seconds (server enforces a minimum)
   */
  this.queryRange = function (query, fromMs, toMs, stepSec) {
    var qs = '?query=' + encodeURIComponent(query)
           + '&start=' + (fromMs / 1000).toFixed(3)
           + '&end='   + (toMs / 1000).toFixed(3)
           + '&step='  + encodeURIComponent(stepSec);
    return request('GET', '/api/v1/query_range' + qs);
  };

  // Instant query (/api/v1/query). Exposed because the live demo uses it
  // as the credential-probe call; not used by the built-in source.
  this.query = function (query, atMs) {
    var qs = '?query=' + encodeURIComponent(query)
           + (atMs != null ? '&time=' + (atMs / 1000).toFixed(3) : '');
    return request('GET', '/api/v1/query' + qs);
  };

  this.setOptions = function (o) {
    Object.assign(config, o || null);
    return Promise.resolve(true);
  };

  this.getConfig = function () {
    // Return a shallow copy so the caller can't mutate our internals.
    return Promise.resolve(Object.assign({}, config));
  };
}

// Parse a Prometheus matrix envelope into the shape the source folds.
// Exported for unit tests. Returns { metric, values } rows; skips NaN
// samples (counter resets, "no data") which are valid in the protocol
// but useless in a chart.
export function parsePromResponse(json) {
  if (!json || json.status !== 'success' || !json.data) return [];
  if (json.data.resultType !== 'matrix' && json.data.resultType !== 'vector') return [];
  var rows = json.data.result || [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var values = row.values || (row.value ? [row.value] : []);
    var clean = [];
    for (var j = 0; j < values.length; j++) {
      var pair = values[j];
      var t = +pair[0];
      var raw = pair[1];
      // Prometheus serialises NaN as the string 'NaN'. JSON.parse turns
      // it into the number NaN; both skip cleanly here.
      var v = +raw;
      if (v === v) clean.push([t, v]);   // NaN !== NaN
    }
    out.push({ metric: row.metric || {}, values: clean });
  }
  return out;
}

export default jpPrometheus;