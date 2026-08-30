//////////////////////////////////////////////////////
// jpInfluxdb.js                                     //
// Standalone InfluxDB HTTP client — no dependencies //
//////////////////////////////////////////////////////
//
// Usable independently of timeseries.js, like jpZabbix.js and caldav.js.
// Every public method returns a Promise. Errors reject with
// { code, data, message } — code 0 means the request never reached the
// server (network error or timeout).
//
//   var i = new jpInfluxdb({ url: 'http://localhost:8086', mode: '1x',
//                             token: '…', db: 'mydb' });
//   i.query('SELECT mean(value) FROM cpu GROUP BY time(60s)', fromMs, toMs).then(…);
//
// Two APIs in one client. `mode: '1x'` uses InfluxQL against POST /query with
// a form-encoded body; `mode: '2x'` uses Flux against POST /api/v2/query
// with a JSON body. The internal normalised shape is the same in both cases,
// so the source plugin does not branch.
//
// CORS: a browser talking straight to InfluxDB needs that server to answer
// the preflight with POST in Access-Control-Allow-Methods and Authorization
// in Access-Control-Allow-Headers (a wildcard provably does not cover it).
// Auth travels in an explicit header rather than cookies
// (credentials: 'omit'), so a wildcard Access-Control-Allow-Origin is
// sufficient. Where none of that can be arranged, set `proxy` to a
// same-origin forwarder.

function fail(code, message, data) {
  return { code: code, message: message, data: data };
}

// Auth header: token wins (revocable), basic is the fallback. InfluxDB 2.x
// accepts only the token; basic is silently dropped. Headers other than
// Authorization merge on top.
function authHeader(config) {
  var h = {};
  if (config.token != null) {
    h.Authorization = 'Token ' + config.token;
  } else if (config.username != null) {
    h.Authorization = 'Basic ' + btoa(config.username + ':' + (config.password || ''));
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

/**
 * @param {{
 *   url?: string,
 *   mode?: '1x' | '2x',
 *   db?: string,            // mode 1x: database name
 *   org?: string,           // mode 2x: organisation
 *   bucket?: string,        // mode 2x: bucket (sent as part of the Flux query)
 *   token?: string,
 *   username?: string, password?: string,
 *   headers?: object,
 *   proxy?: string,
 *   timeout?: number,
 * }} options
 */
function jpInfluxdb(options) {
  var config = {};
  Object.assign(config, {
    url: 'http://localhost:8086',
    mode: '1x',
    db: null,
    org: null,
    bucket: null,
    token: null,
    username: null,
    password: null,
    headers: null,
    proxy: null,
    timeout: 20000,
  }, options);
  if (config.mode !== '1x' && config.mode !== '2x') {
    throw new Error('jpInfluxdb: mode must be "1x" or "2x"');
  }

  function request(method, path, body, contentType, extraHeaders, acceptOverride) {
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = (ctl && config.timeout != null)
      ? setTimeout(function () { ctl.abort(); }, config.timeout)
      : null;
    var headers = Object.assign({}, authHeader(config));
    headers.Accept = acceptOverride || 'application/json';
    if (contentType) headers['Content-Type'] = contentType;
    if (extraHeaders) for (var ek in extraHeaders) headers[ek] = extraHeaders[ek];
    return fetch(endpoint(config, path), {
      method: method,
      headers: headers,
      body: body || undefined,
      signal: ctl && ctl.signal,
      credentials: 'omit',
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (res.status >= 400) {
        return res.text().then(function (text) {
          throw fail(res.status, 'influxdb http ' + res.status, text);
        }, function () {
          throw fail(res.status, 'influxdb http ' + res.status, null);
        });
      }
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('application/json') !== -1) {
        return res.json().then(function (json) { return { json: json, raw: null }; });
      }
      return res.text().then(function (text) { return { json: null, raw: text }; });
    }, function (e) {
      if (timer) clearTimeout(timer);
      if (e && typeof e.code === 'number') throw e;
      var aborted = e && (e.name === 'AbortError' || /aborted/i.test(String(e && e.message)));
      throw fail(0, aborted
        ? 'influxdb timeout after ' + config.timeout + 'ms for ' + path
        : 'influxdb network error for ' + path + ': ' + (e && e.message), null);
    });
  }

  /**
   * Issue a query in the configured mode. Returns the normalised envelope:
   *   { series: [{ name, tags, columns, values }] }
   * Empty/invalid responses yield an empty `series` array.
   *
   * The 1.x body is form-encoded (db&q&epoch=ms); 2.x uses JSON with the
   * Flux query. The same call signature in both modes is deliberate: the
   * source does not branch.
   *
   * @param {string} q InfluxQL (mode 1x) or Flux (mode 2x)
   * @param {number} [fromMs] start of the window; 1.x appends `time >= <ms>`
   * @param {number} [toMs]   end of the window;   1.x appends `time < <ms>`
   */
  this.query = function (q, fromMs, toMs) {
    if (config.mode === '1x') {
      // Append a time range to the InfluxQL query so a caller doesn't have
      // to remember to include it. The Flux side does this naturally via
      // range() so we leave it alone there.
      var body = 'db=' + encodeURIComponent(config.db || '')
               + '&q=' + encodeURIComponent(q)
               + '&epoch=ms';
      if (fromMs != null) body += '&from=' + fromMs;
      if (toMs != null)   body += '&to='   + toMs;
      return request('POST', '/query', body, 'application/x-www-form-urlencoded').then(function (resp) {
        return parse1x(resp.json);
      });
    }
    // mode 2x
    var body2 = JSON.stringify({
      org: config.org || '',
      query: q,
      type: 'flux',
      dialect: { header: true, annotations: ['group', 'datatype', 'default'] },
    });
    // Ask for CSV (no annotations column): the smallest, simplest Flux
    // response, and the one that survives a wide variety of InfluxDB
    // Cloud / OSS versions without dialect-version negotiation.
    return request('POST', '/api/v2/query', body2, 'application/json', null, 'text/csv').then(function (resp) {
      return parse2x(resp);
    });
  };

  this.setOptions = function (o) {
    Object.assign(config, o || null);
    return Promise.resolve(true);
  };

  this.getConfig = function () {
    return Promise.resolve(Object.assign({}, config));
  };
}

// 1.x envelope: { results: [{ statement_id, series: [...] }] }.
// An individual statement can be `{ error: '…' }` instead of carrying
// `series` — surface that as a server error rather than a silent empty.
function parse1x(json) {
  if (!json) return { series: [] };
  var out = [];
  var results = json.results || [];
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (r && r.error) throw fail(502, 'influxdb: ' + r.error, r.statement_id);
    var series = r && r.series;
    if (!series) continue;
    for (var j = 0; j < series.length; j++) {
      var s = series[j];
      var columns = s.columns || [];
      var timeIdx = columns.indexOf('time');
      var valueIdx = columns.length > 1 ? columns.length - 1 : (timeIdx === 0 ? -1 : 0);
      var values = s.values || [];
      var points = [];
      for (var k = 0; k < values.length; k++) {
        var row = values[k];
        var t = timeIdx >= 0 ? +row[timeIdx] : +row[0];
        var v = valueIdx >= 0 ? +row[valueIdx] : NaN;
        if (v === v) points.push([t, v]);
      }
      out.push({ name: s.name || '', tags: s.tags || {}, points: points });
    }
  }
  return { series: out };
}

// 2.x CSV (the response shape we request). Each row is
//   ,result,table,_start,_stop,_time,_value,_field,_measurement
// for annotated CSV; with `annotations: ['default']` we get just the
// data columns plus `time` + `value`. Two series under one Flux query
// show up as a `#group` annotation comment header before each chunk; we
// detect that by tracking `result` + `table` columns.
function parse2x(resp) {
  var text = resp.raw || '';
  if (!text) return { series: [] };
  var lines = text.split('\n');
  // Strip the comment lines (#group, #datatype, …) — they begin with `#`.
  lines = lines.filter(function (l) { return l.length > 0 && l[0] !== '#'; });
  if (!lines.length) return { series: [] };
  var headerLine = lines[0];
  var cols = headerLine.split(',');
  // Find the indices we care about.
  function idx(name) {
    for (var i = 0; i < cols.length; i++) if (cols[i] === name) return i;
    return -1;
  }
  var tIdx = idx('time') !== -1 ? idx('time') : idx('_time');
  // In annotated CSV the value column carries its own header
  // (`_value` or the original field name). Pick the rightmost non-control
  // column as the value when neither is present.
  var vIdx = idx('value');
  if (vIdx === -1) vIdx = idx('_value');
  if (vIdx === -1) {
    for (var c = cols.length - 1; c >= 0; c--) {
      if (cols[c] === 'time' || cols[c] === '_time' || cols[c] === 'table' || cols[c] === 'result'
            || cols[c] === '_start' || cols[c] === '_stop') continue;
      vIdx = c; break;
    }
  }
  var resultIdx = idx('result');
  var tableIdx = idx('table');
  var nameIdx = vIdx;
  var seriesMap = new Map();
  for (var i = 1; i < lines.length; i++) {
    var row = lines[i];
    if (!row) continue;
    var fields = row.split(',');
    var t = +(fields[tIdx] || 0);
    var v = +(fields[vIdx] || 'NaN');
    if (v !== v) continue;
    var seriesKey = (resultIdx >= 0 ? (fields[resultIdx] || '') : '') + '|'
                  + (tableIdx >= 0 ? (fields[tableIdx] || '') : '');
    var entry = seriesMap.get(seriesKey);
    if (!entry) {
      var nm = resultIdx >= 0 ? (fields[resultIdx] || '') : (nameIdx >= 0 ? (fields[nameIdx] || '') : '');
      entry = { name: nm, tags: {}, points: [] };
      seriesMap.set(seriesKey, entry);
    }
    entry.points.push([t, v]);
  }
  return { series: Array.from(seriesMap.values()) };
}

export { parse1x, parse2x };
export default jpInfluxdb;