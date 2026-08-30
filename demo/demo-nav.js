/* ──────────────────────────────────────────────────────────────────────────
   timeseries.js demo pages — shared navigation bar and theme picker.

   A *classic* script on purpose (no import/export): index.html loads the IIFE
   bundle, while caldav.html, zabbix.html and zabbix-live.html are ES modules
   importing ../src/ directly. A classic script is the one form all of them can
   load, and it runs before every deferred module script, so `window.demoTheme`
   is defined by the time any page script wants to subscribe.

   Drop `<div id="demo-nav"></div>` inside the page's <header> and load this
   file right after `</header>`, so the theme class lands on <body> before the
   page below it paints.

   It knows nothing about TimeSeries — it only owns the <body> class, the
   picker UI and localStorage. Pages repaint their own charts from onChange().

   Public API:
     window.demoTheme.current          → 'light' | 'dark' | 'highContrast' | 'warm'
     window.demoTheme.apply(name)      → switch theme (persists, notifies)
     window.demoTheme.onChange(fn)     → subscribe; fires immediately with the
                                         current theme, returns an unsubscribe
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var STORAGE_KEY = 'timeseries-demo-theme';

  // `light` is the bare default and deliberately carries no body class.
  var THEMES = [
    { name: 'light',        label: 'Light',         cls: 'theme-btn-light' },
    { name: 'dark',         label: 'Dark',          cls: 'theme-btn-dark'  },
    { name: 'highContrast', label: 'High contrast', cls: 'theme-btn-hc'    },
    { name: 'warm',         label: 'Warm',          cls: 'theme-btn-warm'  }
  ];

  // An entry is either a single page, `{href, label}`, or a labelled group of
  // them, `{group, pages: […]}`. The group form is for several pages on the
  // *same topic at a different fidelity* — not for two topics. Repeating the
  // topic in two flat pills ("Zabbix", "Zabbix live") is both wider and vaguer
  // than naming it once around a pair whose labels are only the qualifier.
  var PAGES = [
    { href: 'index.html',  label: 'Overview' },
    { group: 'Calendar', pages: [
      { href: 'caldav.html',      label: 'demo', title: 'CalDAV — fixtures, needs no server' },
      { href: 'caldav-live.html', label: 'live', title: 'CalDAV — connects to a real server' }
    ] },
    { group: 'Zabbix', pages: [
      { href: 'zabbix.html',      label: 'demo', title: 'Zabbix — synthetic, needs no server' },
      { href: 'zabbix-live.html', label: 'live', title: 'Zabbix — connects to a real server' }
    ] },
    { group: 'Prometheus', pages: [
      { href: 'prometheus.html',      label: 'demo', title: 'Prometheus — synthetic, needs no server' },
      { href: 'prometheus-live.html', label: 'live', title: 'Prometheus — connects to a real server (also VictoriaMetrics, Thanos, Cortex, Mimir)' }
    ] },
    { group: 'Home Assistant', pages: [
      { href: 'home-assistant.html',      label: 'demo', title: 'Home Assistant — synthetic, needs no server' },
      { href: 'home-assistant-live.html', label: 'live', title: 'Home Assistant — connects to a real server' }
    ] },
    { group: 'InfluxDB', pages: [
      { href: 'influxdb.html',      label: 'demo', title: 'InfluxDB 1.x/2.x — synthetic, needs no server' },
      { href: 'influxdb-live.html', label: 'live', title: 'InfluxDB — connects to a real server' }
    ] },
    { group: 'Adapters', pages: [
      { href: 'websocket.html',   label: 'WebSocket', title: 'WebSocket adapter — bring your own WS server' },
      { href: 'duckdb-wasm.html', label: 'DuckDB-WASM', title: 'DuckDB-WASM adapter — bring your own in-browser DB' }
    ] },
    { href: 'https://github.com/hgruber/timeseries.js', label: 'GitHub', external: true }
  ];

  // ── Theme state ─────────────────────────────────────────────────────────
  function isKnown(name) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].name === name) return name;
    return null;
  }

  function readStored() {
    // Storage throws in private mode / with cookies blocked — a demo page must
    // not die over a persistence nicety.
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function writeStored(name) {
    try { localStorage.setItem(STORAGE_KEY, name); } catch (e) { /* ignore */ }
  }

  var current   = isKnown(readStored()) || 'light';
  var listeners = [];
  var buttons   = {};        // theme name → its swatch button

  function paint() {
    if (document.body) {
      for (var i = 0; i < THEMES.length; i++) {
        var t = THEMES[i].name;
        document.body.classList.toggle('theme-' + t, t === current && t !== 'light');
      }
    }
    for (var name in buttons) {
      if (!Object.prototype.hasOwnProperty.call(buttons, name)) continue;
      buttons[name].classList.toggle('active', name === current);
      buttons[name].setAttribute('aria-pressed', String(name === current));
    }
  }

  function apply(name) {
    var next = isKnown(name);
    if (!next) return;
    var changed = next !== current;
    current = next;
    paint();
    if (!changed) return;
    writeStored(next);
    listeners.slice().forEach(function (fn) { fn(current); });
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    fn(current);      // late subscribers (module scripts) still get the initial palette
    return function unsubscribe() {
      var i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  // ── Markup ──────────────────────────────────────────────────────────────
  // The file name of the page we are on; a bare directory URL ('/demo/') and
  // '/demo/index.html' are the same page.
  var here = location.pathname.split('/').pop() || 'index.html';

  // Shared by both the flat and the grouped path, so the current-page and
  // external handling exists once. `groupName` is set only inside a group.
  function navLink(p, groupName) {
    var a = document.createElement('a');
    a.href = p.href;
    a.textContent = p.label;
    if (p.title) a.title = p.title;
    // In a group the visible text is only the qualifier, so a screen reader's
    // list of links would read "demo", "live" — useless out of context. The
    // full name goes on aria-label there; a flat entry already reads whole.
    if (groupName) a.setAttribute('aria-label', groupName + ' ' + p.label);
    if (p.external) a.rel = 'noopener';
    else if (p.href === here) a.setAttribute('aria-current', 'page');
    return a;
  }

  function navGroup(g) {
    var box = document.createElement('span');
    box.className = 'nav-group';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', g.group);

    // aria-hidden: role=group's own aria-label already announces the name, so
    // exposing the visible copy too would say it twice.
    var label = document.createElement('span');
    label.className = 'nav-group-label';
    label.textContent = g.group;
    label.setAttribute('aria-hidden', 'true');
    box.appendChild(label);

    g.pages.forEach(function (p) { box.appendChild(navLink(p, g.group)); });
    return box;
  }

  function buildNav() {
    var nav = document.createElement('nav');
    nav.className = 'demo-nav';
    nav.setAttribute('aria-label', 'Demo pages');

    PAGES.forEach(function (p) {
      nav.appendChild(p.pages ? navGroup(p) : navLink(p));
    });
    return nav;
  }

  function buildPicker() {
    var picker = document.createElement('div');
    picker.className = 'theme-picker';
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', 'Colour theme');

    THEMES.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-btn ' + t.cls;
      b.title = t.label;
      b.setAttribute('aria-label', t.label + ' theme');
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () { apply(t.name); });
      buttons[t.name] = b;
      picker.appendChild(b);
    });
    return picker;
  }

  function init() {
    var host = document.getElementById('demo-nav');
    if (host) host.replaceChildren(buildNav(), buildPicker());
    paint();
  }

  window.demoTheme = {
    get current() { return current; },
    apply: apply,
    onChange: onChange
  };

  paint();      // body class first, so the page never flashes the light theme

  if (document.getElementById('demo-nav') || document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
