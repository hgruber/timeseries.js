//////////////////////////////////////////////////////
// caldav.js                                        //
// standalone CalDAV client — no dependencies       //
//////////////////////////////////////////////////////
//
// Usable independently of timeseries.js, like jpZabbix.js. Every public method
// returns a Promise. Errors reject with { code, data, message } — code 0 means
// the request never reached the server.
//
//   var cal = new CalDAV({ url: 'https://dav.example/', username: 'u', password: 'p' });
//   cal.discover().then(cals => cal.query(cals[0].href, from, to)).then(events => …);
//
// CORS: a browser talking straight to a CalDAV server needs that server to
// answer the preflight with PROPFIND/REPORT in Access-Control-Allow-Methods
// and Authorization in Access-Control-Allow-Headers. Auth travels in an
// explicit header rather than cookies (credentials: 'omit'), so a wildcard
// Access-Control-Allow-Origin is sufficient. Where none of that can be
// arranged, set `proxy` to a same-origin forwarder.

var NS_DAV = 'DAV:';
var NS_CALDAV = 'urn:ietf:params:xml:ns:caldav';
var NS_APPLE = 'http://apple.com/ns/ical/';

function fail(code, message, data) {
  return { code: code, message: message, data: data };
}

// ── iCalendar date handling ──────────────────────────────────────────────────

// Offset (ms) of `tz` at the given instant. Derived by formatting the instant
// in that zone and reading the wall clock back — the only zone database a
// browser exposes.
function zoneOffset(ms, tz) {
  var dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  var p = {};
  for (var part of dtf.formatToParts(new Date(ms))) p[part.type] = part.value;
  // 'en-US' renders midnight as hour 24; Date.UTC handles the rollover.
  var asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - ms;
}

// Wall-clock fields in `tz` → epoch ms. Two passes: the first offset guess is
// taken at the naive instant, the second at the corrected one, which settles
// everything except the ambiguous hour of a DST fall-back (where either answer
// is defensible).
function zonedToEpoch(y, mo, d, h, mi, s, tz) {
  var naive = Date.UTC(y, mo - 1, d, h, mi, s);
  var epoch = naive - zoneOffset(naive, tz);
  return naive - zoneOffset(epoch, tz);
}

/**
 * Parse an iCalendar DATE or DATE-TIME value.
 * @returns {{ ms: number, allDay: boolean }}
 */
export function parseICSDate(value, tzid) {
  var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!m) return { ms: NaN, allDay: false };
  var y = +m[1], mo = +m[2], d = +m[3];
  if (m[4] === undefined) {
    // VALUE=DATE — a floating calendar day. Local midnight is what a viewer
    // in this browser means by "that day".
    return { ms: new Date(y, mo - 1, d).getTime(), allDay: true };
  }
  var h = +m[4], mi = +m[5], s = +m[6];
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  if (tzid) {
    try {
      return { ms: zonedToEpoch(y, mo, d, h, mi, s, tzid), allDay: false };
    } catch {
      // Unknown TZID (e.g. a legacy Exchange zone name): fall through to
      // floating-local rather than dropping the event.
    }
  }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false };
}

// ISO 8601 duration as used by iCalendar: PT1H30M, P2D, -P1D, P1W
function parseDuration(value) {
  var m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!m) return 0;
  var ms = (+(m[2] || 0) * 604800 + +(m[3] || 0) * 86400
          + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// RFC 5545 §3.3.11: \\ \; \, and \n are escaped in TEXT values.
function unescapeText(v) {
  return v.replace(/\\([\\;,nN])/g, function (_, c) {
    return (c === 'n' || c === 'N') ? '\n' : c;
  });
}

/**
 * Parse an iCalendar stream into plain VEVENT objects.
 *
 * Recurrence is deliberately not expanded here — the CalDAV REPORT asks the
 * server to expand it (`<C:expand>`), which is both correct and far cheaper
 * than reimplementing RRULE/EXDATE/RECURRENCE-ID in the browser. A server that
 * ignores `expand` yields the master event only, which still renders.
 *
 * @param {string} text raw text/calendar
 * @returns {Array<{uid,summary,location,status,start,end,allDay,recurrenceId}>}
 */
export function parseICS(text) {
  if (!text) return [];
  // Unfold: RFC 5545 continuation lines begin with a space or tab.
  var lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  var events = [];
  var ev = null;
  var depth = 0;   // nested components (VALARM) must not clobber the VEVENT

  for (var line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = { params: {} }; depth = 0; continue; }
    if (ev === null) continue;
    if (line === 'END:VEVENT') {
      finishEvent(ev, events);
      ev = null;
      continue;
    }
    if (/^BEGIN:/.test(line)) { depth++; continue; }
    if (/^END:/.test(line)) { depth--; continue; }
    if (depth > 0) continue;

    var colon = line.indexOf(':');
    if (colon < 0) continue;
    var head = line.slice(0, colon);
    var value = line.slice(colon + 1);
    var semi = head.indexOf(';');
    var name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
    var params = {};
    if (semi >= 0)
      for (var p of head.slice(semi + 1).split(';')) {
        var eq = p.indexOf('=');
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
      }

    switch (name) {
      case 'UID':          ev.uid = value; break;
      case 'SUMMARY':      ev.summary = unescapeText(value); break;
      case 'LOCATION':     ev.location = unescapeText(value); break;
      case 'STATUS':       ev.status = value; break;
      case 'DTSTART':      ev.dtstart = value; ev.params.DTSTART = params; break;
      case 'DTEND':        ev.dtend = value; ev.params.DTEND = params; break;
      case 'DURATION':     ev.duration = value; break;
      case 'RECURRENCE-ID': ev.recurrenceId = value; break;
    }
  }
  return events;
}

function finishEvent(ev, out) {
  if (!ev.dtstart) return;
  var sp = ev.params.DTSTART || {};
  var start = parseICSDate(ev.dtstart, sp.TZID);
  if (isNaN(start.ms)) return;
  var allDay = start.allDay || sp.VALUE === 'DATE';
  var end;
  if (ev.dtend) {
    var epp = ev.params.DTEND || {};
    end = parseICSDate(ev.dtend, epp.TZID).ms;
  } else if (ev.duration) {
    end = start.ms + parseDuration(ev.duration);
  } else {
    // RFC 5545: a DATE start with no end lasts one day; a DATE-TIME start with
    // no end is instantaneous.
    end = allDay ? start.ms + 86400000 : start.ms;
  }
  if (isNaN(end) || end < start.ms) end = start.ms;
  out.push({
    uid: ev.uid,
    summary: ev.summary || '',
    location: ev.location || '',
    status: ev.status || '',
    recurrenceId: ev.recurrenceId,
    start: start.ms,
    end: end,
    allDay: allDay,
  });
}

// ── XML helpers ──────────────────────────────────────────────────────────────

function parseXML(text) {
  var doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length)
    throw fail(-1, 'malformed XML in CalDAV response', text.slice(0, 500));
  return doc;
}

function firstText(el, ns, tag) {
  var found = el.getElementsByTagNameNS(ns, tag);
  return found.length ? found[0].textContent.trim() : null;
}

// UTC basic-format stamp for time-range filters: 20260720T090000Z
function icsStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// ── client ───────────────────────────────────────────────────────────────────

function CalDAV(options) {
  var config = {};
  Object.assign(config, {
    url: 'http://localhost/dav/',
    username: null,
    password: null,
    token: null,
    proxy: null,      // same-origin forwarder, prefixed to the absolute URL
    timeout: 20000,
  }, options);

  var client = this;

  function authHeader() {
    if (config.token) return 'Bearer ' + config.token;
    if (config.username != null) return 'Basic ' + btoa(config.username + ':' + (config.password || ''));
    return null;
  }

  function absolute(href) {
    return new URL(href, config.url).toString();
  }

  function endpoint(href) {
    var abs = absolute(href);
    return config.proxy ? config.proxy + encodeURIComponent(abs) : abs;
  }

  /**
   * Issue a WebDAV request and return the parsed multistatus document.
   * @returns {Promise<Document>}
   */
  function dav(method, href, body, depth) {
    var headers = { 'Content-Type': 'application/xml; charset=utf-8', 'Depth': depth };
    var auth = authHeader();
    if (auth) headers['Authorization'] = auth;

    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = (ctl && config.timeout)
      ? setTimeout(function () { ctl.abort(); }, config.timeout)
      : null;

    return fetch(endpoint(href), {
      method: method,
      headers: headers,
      body: body,
      signal: ctl ? ctl.signal : undefined,
      // Credentials in the Authorization header, not cookies — 'omit' keeps
      // the CORS contract simple (no allow-credentials requirement).
      credentials: 'omit',
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok)
        return res.text().catch(function () { return ''; }).then(function (t) {
          throw fail(res.status, res.statusText || ('HTTP ' + res.status), t.slice(0, 500));
        });
      return res.text();
    }, function (e) {
      if (timer) clearTimeout(timer);
      if (e && e.code !== undefined) throw e;
      var aborted = e && e.name === 'AbortError';
      throw fail(0, aborted
        ? 'timeout after ' + config.timeout + 'ms for ' + absolute(href)
        : 'request error for ' + absolute(href), String(e));
    }).then(parseXML);
  }

  /**
   * Discover the calendar collections available to the configured user:
   * current-user-principal → calendar-home-set → child collections.
   * @returns {Promise<Array<{href,displayName,color}>>}
   */
  this.discover = function () {
    var body = '<?xml version="1.0" encoding="utf-8"?>'
      + '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';

    return dav('PROPFIND', config.url, body, '0').then(function (doc) {
      var principal = firstText(doc, NS_DAV, 'current-user-principal');
      // Some servers are already pointed at the principal (or expose no
      // current-user-principal at all) — fall back to the configured URL.
      return principal ? absolute(principal) : config.url;
    }).then(function (principalHref) {
      var b = '<?xml version="1.0" encoding="utf-8"?>'
        + '<d:propfind xmlns:d="DAV:" xmlns:c="' + NS_CALDAV + '">'
        + '<d:prop><c:calendar-home-set/></d:prop></d:propfind>';
      return dav('PROPFIND', principalHref, b, '0').then(function (doc) {
        var home = firstText(doc, NS_CALDAV, 'calendar-home-set');
        return home ? absolute(home) : principalHref;
      });
    }).then(function (homeHref) {
      var b = '<?xml version="1.0" encoding="utf-8"?>'
        + '<d:propfind xmlns:d="DAV:" xmlns:a="' + NS_APPLE + '"><d:prop>'
        + '<d:resourcetype/><d:displayname/><a:calendar-color/>'
        + '</d:prop></d:propfind>';
      return dav('PROPFIND', homeHref, b, '1').then(function (doc) {
        var out = [];
        var responses = doc.getElementsByTagNameNS(NS_DAV, 'response');
        for (var i = 0; i < responses.length; i++) {
          var r = responses[i];
          var rt = r.getElementsByTagNameNS(NS_DAV, 'resourcetype');
          if (!rt.length) continue;
          if (!rt[0].getElementsByTagNameNS(NS_CALDAV, 'calendar').length) continue;
          var href = firstText(r, NS_DAV, 'href');
          if (!href) continue;
          out.push({
            href: absolute(href),
            displayName: firstText(r, NS_DAV, 'displayname') || href,
            color: firstText(r, NS_APPLE, 'calendar-color'),
          });
        }
        return out;
      });
    });
  };

  /**
   * Fetch the VEVENTs of one calendar overlapping [fromMs, toMs).
   * Recurrences are expanded server-side.
   * @returns {Promise<Array>} parsed events
   */
  this.query = function (href, fromMs, toMs) {
    var range = 'start="' + icsStamp(fromMs) + '" end="' + icsStamp(toMs) + '"';
    var body = '<?xml version="1.0" encoding="utf-8"?>'
      + '<c:calendar-query xmlns:d="DAV:" xmlns:c="' + NS_CALDAV + '">'
      + '<d:prop><d:getetag/>'
      + '<c:calendar-data><c:expand ' + range + '/></c:calendar-data>'
      + '</d:prop>'
      + '<c:filter><c:comp-filter name="VCALENDAR">'
      + '<c:comp-filter name="VEVENT"><c:time-range ' + range + '/></c:comp-filter>'
      + '</c:comp-filter></c:filter></c:calendar-query>';

    return dav('REPORT', href, body, '1').then(function (doc) {
      var out = [];
      var nodes = doc.getElementsByTagNameNS(NS_CALDAV, 'calendar-data');
      for (var i = 0; i < nodes.length; i++)
        for (var ev of parseICS(nodes[i].textContent)) out.push(ev);
      return out;
    });
  };

  /**
   * Fetch several calendars at once. Individual failures are reported rather
   * than sinking the whole batch — one broken calendar should not blank the
   * chart.
   * @returns {Promise<Array<{calendar,events,error}>>}
   */
  this.queryAll = function (calendars, fromMs, toMs) {
    return Promise.all(calendars.map(function (cal) {
      return client.query(cal.href, fromMs, toMs).then(
        function (events) { return { calendar: cal, events: events }; },
        function (error) { return { calendar: cal, events: [], error: error }; },
      );
    }));
  };

  this.setOptions = function (addoptions) {
    Object.assign(config, addoptions);
    return Promise.resolve(true);
  };

  this.getConfig = function () {
    return Promise.resolve(config);
  };
}

export default CalDAV;
