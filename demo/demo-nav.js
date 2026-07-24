/* ──────────────────────────────────────────────────────────────────────────
   timeseries.js demo pages — shared navigation bar and theme picker.

   A *classic* script on purpose (no import/export): index.html loads the IIFE
   bundle, while caldav.html and zabbix.html are ES modules importing ../src/
   directly. A classic script is the one form all three can load, and it runs
   before every deferred module script, so `window.demoTheme` is defined by the
   time any page script wants to subscribe.

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

  var PAGES = [
    { href: 'index.html',  label: 'Overview' },
    { href: 'caldav.html', label: 'Calendar' },
    { href: 'zabbix.html', label: 'Zabbix'   },
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

  function buildNav() {
    var nav = document.createElement('nav');
    nav.className = 'demo-nav';
    nav.setAttribute('aria-label', 'Demo pages');

    PAGES.forEach(function (p) {
      var a = document.createElement('a');
      a.href = p.href;
      a.textContent = p.label;
      if (p.external) a.rel = 'noopener';
      else if (p.href === here) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
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
