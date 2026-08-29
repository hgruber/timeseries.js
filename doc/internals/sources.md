# Internals — data sources

The source-plugin contract and the two built-in clients. Usage is documented in
[Data sources](../sources.md); this page carries the design decisions behind them —
the ring caches, the sequence guards, and the CORS wall that shapes both demos.

Source: `src/sources.js`, `src/caldav.js`, `src/jpZabbix.js`.

## The source plugin contract

**Source plugin** (`src/sources.js`):
```js
TimeSeries.registerSource({
  type: 'my-source',
  init(source, callbacks) {
    /* callbacks: { pushData(plotObj) → id, replaceData(id, plotObj), removeData(id),
                    requestRedraw(), getViewport() → {tmin, tmax, ppms},
                    onViewportChange(fn) } */
  }
});
```

Both `registerRenderer` and `registerSource` are available on the built IIFE as `TimeSeries.registerRenderer` / `TimeSeries.registerSource`, and as named ES module exports for use in `src/`.

## CalDAV source

```js
{ 'source-type': 'caldav',
  url, username, password, 'auth-token', proxy,   // see src/caldav.js
  calendars: [href | {href,label,color}],         // omit → discover()
  layout: 'calendar' | 'packed',
  padding: 0.5 }                                  // extra window fetched either side
```
Fetches VEVENTs overlapping the padded viewport and refetches via `onViewportChange` only when
panning leaves the fetched window; stale responses are dropped by sequence number. Recurrence is
expanded **server-side** via `<C:expand>` — `caldav.js` deliberately does not implement RRULE.
After init, `source.client` is the CalDAV client and `source.setLayout(l)` re-packs without a
refetch.

Note the `timeout` key is only forwarded when set. `CalDAV`'s constructor merges via
`Object.assign`, which overwrites a default with a present-but-`undefined` key, so passing it
unconditionally replaced the 20 s default with `undefined` — and `caldav.js`'s
`ctl && config.timeout` then armed no abort timer at all, leaving a hung request pending forever.

Two demos, and the split between them mirrors the two Zabbix pages:

- **`demo/caldav.html`** needs no server. With none configured it parses the static fixtures in
  `demo/fixtures/` (shifted onto the current week), so the renderer and parser are testable with
  no infrastructure.
- **`demo/caldav-live.html`** talks to a *real* server: URL, user, password and an optional
  proxy prefix go into a connect form, `discover()` doubles as the credential probe and as the
  calendar list, and a `<select multiple>` picks which calendars are drawn. Credentials land in
  `sessionStorage` (a password, unlike an API token, cannot be revoked server-side) and only
  reach `localStorage` if the user ticks the box.

That page does **not** use the built-in `caldav` source, and deliberately so: the source's
calendar list is fixed once `init()` has run, and it reports failures to `console.warn` only, so
there is nothing to hang a status line, the per-calendar counts or the legend off. It registers
a page-local `caldav-live` source instead — the same arrangement `demo/zabbix-live.html` uses
for `zabbix-problems`/`zabbix-items`. What that source adds over the built-in one is
`setCalendars(list)` at runtime, backed by a per-calendar event cache keyed to the window
currently held, so deselecting a calendar costs no request and reselecting one is free unless
the window has moved since; plus `onUpdate`/`onError`. Everything else — the padded window, the
sequence guard, the span-plot shape, `setLayout` — mirrors `src/sources.js` on purpose.

**The CORS wall, and `scripts/dev-server.mjs`.** A browser will not talk to a CalDAV server on
another origin unless that server answers the `OPTIONS` preflight — and most do not: they demand
authentication for it and answer `401`, which is fatal *regardless of any header*, because a
preflight must return 2xx. There is no client-side fix; the server has to answer `OPTIONS`
before its auth layer (Nextcloud behind Apache/nginx/HAProxy, an `Allow-Headers` list that names
`Authorization` explicitly — a `*` provably does not cover it).

For local development the way around it is the `proxy` option `src/caldav.js` already has:
`endpoint()` builds `proxy + encodeURIComponent(absoluteURL)`, so a same-origin forwarder makes
the whole CORS question disappear rather than satisfying it. `npm run serve:proxy`
(`scripts/dev-server.mjs`) is that forwarder: the same static server as `npm run serve` plus one
route, `/dav-proxy?url=…`, which replays the request (method, `Authorization`, `Depth`,
`Content-Type`, body) from Node — where the same-origin policy, a browser rule, does not exist.
Enter `/dav-proxy?url=` in the page's Proxy field. It binds to 127.0.0.1 only, since a proxy
that forwards to an arbitrary target URL is an open relay; `DAV_PROXY_ALLOW` narrows it to a
host list. `npm run serve` stays as it was — the proxy is opt-in, and the deployed Pages copy
has none, so there the server-side CORS config is the only option.

## Zabbix source — zoom-adaptive history/trends

```js
{ 'source-type': 'zabbix',
  url, username, password, 'auth-token',           // see src/jpZabbix.js (token skips login)
  itemids: [itemid, …],                            // each item is one band series
  'value-type': 0,                                 // history.get value type (0 float, 3 unsigned)
  'history-interval': 60,                          // fine tier bucket seconds
  tiers: [{interval, kind:'history'|'trends'}],    // optional; default 60s history + 3600s trends
  padding: 0.5,                                    // prefetch fraction fetched either side
  render: 'quantile-bands',                        // any ladder type; applies to ALL tiers
  series_colors: { [itemid]: cssColor }, name }
```

`render` exists because a `[min, avg, max]` cell is equally a band, a step, an error bar or
a candle. It is validated against `isBandedType()` and falls back with a warning, and it
deliberately has no per-tier form: `_fade` groups by `plot.type`, so two types would pop
instead of dissolving.

Two (or more) **resolution tiers coexist as `quantile-bands` plots that differ only in
`interval`**. Both `history` (raw, binned to min/avg/max per bucket) and `trends` (Zabbix's
hourly `value_min/avg/max`) map to the **same `[min, avg, max]` band shape**, so history draws
as a single line (min=avg=max at ~1 sample/bucket) and trends as a filled band — via the one
`quantile-bands` renderer. The core's `prepare_grid` picks the finest tier whose buckets are
≥ 2px per zoom (the same rule the source uses to decide what to fetch, `zabbixPrimaryTier`),
so no extra switch logic is needed. `jpZabbix.api()` is generic, so `trends.get` needs no
client change.

Each tier is a **self-managed ring cache** (mirrors the CalDAV pattern): one `replaceData`
block, prefetching ±`padding` around the viewport, refetched via `onViewportChange` only when
the *viewport* nears the fetched edge, stale responses dropped by sequence number. The ring
(`Map<slot, {[itemid]:{mn,av,mx,n}}>`) retains **multiple visited windows** so panning back is
instant, and is bounded by `ZBX_MAX_SLOTS`, evicting the slots farthest from the viewport
centre. The pure ring helpers (`zabbixPrimaryTier`, `zabbixWindow`, `zabbixClearRange`,
`zabbixFold`, `zabbixEvict`, `zabbixPlot`) are **exported from `src/sources.js`** for testing.

**Cross-fade at the switch** is the
[generic tier mechanism](core.md#resolution-tiers-and-the-cross-fade-any-renderer) — the Zabbix source
adds nothing to it beyond making sure the data is there: prefetch means the incoming tier is
already cached, so the dissolve never waits on the network.

Two demos, and the split between them is deliberate:

- **`demo/zabbix.html`** needs no server. It installs a synthetic `api_jsonrpc.php` (a fake
  `XMLHttpRequest` answering `history.get`/`trends.get` with a generated signal), so the
  **real** `zabbix` source — login flow, tiering, prefetch, ring, cross-fade — runs unchanged
  with no infrastructure.
- **`demo/zabbix-live.html`** talks to a *real* Zabbix server: API URL and token go into a
  connect form (stored in `localStorage` only after one successful authenticated round trip;
  the page says so in a banner) and it registers two page-local sources of its own,
  `zabbix-problems` (an `event.get`/`problem.get` gantt) and `zabbix-items` (a picker feeding
  the history/trends band), on two viewport-synced instances. It carries no credentials in the
  source, which is why it lives in `demo/` and is deployed like the rest — see the banner for
  what that means for a token typed into the Pages copy.

## The README server recipes, and why their URL rules differ

README's *Connect to a real server* hangs two single-file recipes off it (Zabbix, CalDAV),
whose whole CORS story is "put the file on the host that serves the API" — an origin is
scheme+host+port, so the path is free. Two traps those recipes encode, both verified by
constructing them headlessly against `test/helpers/dom.mjs`:

- **CalDAV's `url` must be absolute.** `absolute()` in `src/caldav.js` is
  `new URL(href, config.url)`, and a relative *base* is not a valid URL — it throws in the
  browser exactly as it does in Node. The recipe therefore uses `location.origin + '/…'`,
  which stays same-origin without hard-coding a host. Calendar hrefs, resolved *against*
  that base, may be relative.
- **Zabbix's `url` may be relative** (`/zabbix/api_jsonrpc.php`): `jpZabbix.api()` hands it
  to `XMLHttpRequest.open()`, which resolves against the document base.

`src/jpZabbix.js` has **no `proxy` option** (unlike `src/caldav.js`), so `serve:proxy`'s
forwarder is a CalDAV-only escape hatch; the README's CORS section says so rather than
papering over it. That was a deliberate call — the recipes solve CORS by placement, not by
proxying.
