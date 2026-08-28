# Data sources

A source is what puts data into the chart. Each entry in the constructor's `sources` array
is handed to the plugin named by its `source-type` key.

| `source-type` | Fetches from | Produces |
|---|---|---|
| `artificial` | nothing — the object *is* the data | whatever shape you wrote |
| `zabbix` | Zabbix JSON-RPC API | a ladder block (`quantile-bands` by default), two resolution tiers |
| `caldav` | a CalDAV server | `gantt` spans |
| *(yours)* | anything | anything — see [Plugins](plugins.md) |

---

## `artificial` — data you already have

The pass-through source. The source object is used as the plot object directly, so its
fields are the [plot object fields](data-formats.md).

```js
sources: [{
  'source-type': 'artificial',
  type: 'multibar',
  interval_start: t0, interval_end: t0 + 86400,
  interval: 3600, count: 24, min: 0, max: 130,
  data: { 0: { ok: 91 }, 1: { ok: 88 } },
}]
```

Use it for static data, for data you fetched yourself, and for prototyping. To update it
later you need a source of your own — see [Plugins](plugins.md#custom-data-source).

---

## Zabbix

Zoom-adaptive: raw `history` and hourly `trends` are held as two
[resolution tiers](tiers.md) and dissolved into each other as you zoom, so crossing the
history/trends boundary has no visible pop.

```js
sources: [{
  'source-type': 'zabbix',
  url: 'https://zabbix.example.org/api_jsonrpc.php',   // may be relative
  'auth-token': '…',                 // or username + password to log in
  itemids: [12345, 12346],           // one min/avg/max band per item
  'value-type': 0,                   // history.get value type: 0 float, 3 unsigned
  'history-interval': 60,            // fine tier bucket seconds (default 60)
  padding: 0.5,                      // extra window prefetched either side
  series_colors: { 12345: '#2d6a9f' },
  name: 'CPU load',
  // tiers: [{ interval: 60,   kind: 'history' },
  //         { interval: 3600, kind: 'trends'  }],   // the default ladder
}]
```

| Option | Default | Notes |
|---|---|---|
| `url` | — | May be **relative** (`/zabbix/api_jsonrpc.php`) — it goes to `XMLHttpRequest.open()`, which resolves against the document base |
| `'auth-token'` | — | An API token; skips the login round trip. Preferred — a token can be revoked server-side, a password cannot |
| `username` / `password` | — | Alternative to the token |
| `itemids` | — | Each item becomes one band series |
| `'value-type'` | `0` | **Must match the item.** `0` float, `3` unsigned |
| `'history-interval'` | `60` | Bucket width of the fine tier, seconds |
| `tiers` | 60 s history + 3600 s trends | `[{ interval, kind: 'history' \| 'trends' }]` |
| `padding` | `0.5` | Fraction of the viewport prefetched either side |
| `render` | `'quantile-bands'` | Which [ladder renderer](data-formats.md#the-four-renderers) draws the block: also `'quantile-steps'`, `'error-bars'`, `'candlestick'`. Applies to **every** tier — the cross-fade groups blocks by type, so two of them would pop rather than dissolve. Anything that is not a ladder type warns and falls back |

Both tiers map to the same `[min, avg, max]` band shape, which is why one
`quantile-bands` renderer draws the fine tier as a single line (min = avg = max at about one
sample per bucket) and the coarse tier as a filled envelope. `render: 'quantile-steps'`
draws that same envelope without interpolating between buckets; `'error-bars'` and
`'candlestick'` turn each bucket into its own glyph.

Each tier is a self-managed ring cache: it prefetches ±`padding` around the viewport,
refetches only when panning nears the fetched edge, retains previously visited windows so
panning back is instant, and drops stale responses by sequence number. The cache is bounded,
evicting the slots furthest from the viewport centre.

After init, `source.server` is the [`jpZabbix`](../src/jpZabbix.js) client, so a page can
issue its own API calls on the same connection.

> **An empty chart is almost always `'value-type'`.** If it does not match the item,
> `history.get` returns an empty list *without an error* — trends still arrive, so the chart
> mysteriously fills in as soon as you zoom out.

> **`jpZabbix.api()` sets a request timeout but never wires `ontimeout`**, so a timed-out
> XHR settles nothing and its promise never resolves. If you call the client directly and
> need a timeout, race it yourself.

---

## CalDAV

Fetches VEVENTs overlapping the viewport and draws them as [spans](data-formats.md#spans-gantt).

```js
sources: [{
  'source-type': 'caldav',
  url: 'https://dav.example.org/remote.php/dav/',   // MUST be absolute
  username: 'me',
  password: '…',                     // or 'auth-token' for bearer auth
  // calendars: ['/remote.php/dav/calendars/me/personal/'],  // omit → discover()
  layout: 'calendar',                // or 'packed'
  padding: 0.5,
  // proxy: '/dav-proxy?url=',       // same-origin forwarder, see CORS below
  // timeout: 20000,                 // ms; only pass it if you mean it
}]
```

| Option | Default | Notes |
|---|---|---|
| `url` | — | **Must be absolute.** Calendar hrefs are resolved against it, and a relative base is not a valid URL. Use `location.origin + '/…'` to stay same-origin without hard-coding a host |
| `username` / `password` | — | HTTP Basic |
| `'auth-token'` | — | Bearer auth instead |
| `calendars` | discover | `[href]` or `[{ href, label, color }]`. Omitted → the source discovers every calendar of that user. Hrefs *may* be relative |
| `layout` | `'calendar'` | `'calendar'` = one row block per calendar; `'packed'` = greedy-packed into one band |
| `padding` | `0.5` | Fraction of the viewport fetched either side |
| `timeout` | `20000` ms | **Only pass this key if you are setting it** — see below |

After init, `source.client` is the CalDAV client and `source.setLayout(l)` re-packs without
a refetch.

Recurrence is expanded **server-side** via `<C:expand>` — the bundled parser deliberately
does not implement RRULE. A server that ignores `expand` returns the master event only,
which still renders as a single bar.

> **Do not pass `timeout: undefined`.** The client merges config with `Object.assign`, which
> lets a present-but-`undefined` key overwrite the 20-second default with nothing — and the
> abort timer is then never armed, so a hung request stays pending forever. Set the key or
> omit it; do not forward an optional variable unconditionally.

---

## Complete recipes against a real server

One HTML file each, no npm and no checkout. Both **put the file on the web server that
serves the API** — an origin is scheme + host + port, so the path does not matter and the
browser makes no cross-origin check at all.

### Zabbix, end to end

1. **Get a token** — Zabbix frontend → *User settings → API tokens → Create API token*. A
   read-only user is enough.
2. **Get an item id** — *Monitoring → Latest data*, open the item; the URL carries `itemid=…`.
3. **Drop the file next to the frontend** — save it anywhere on the host serving Zabbix
   (e.g. `/usr/share/zabbix/ts.html`) and open `https://<zabbix-host>/ts.html`.

```html
<!DOCTYPE html>
<meta charset="utf-8">
<title>Zabbix — timeseries.js</title>
<canvas id="chart" style="width:100%;height:360px"></canvas>

<script src="https://cdn.jsdelivr.net/npm/@hgruber/timeseries.js@0.9/dist/timeseries.min.js"></script>
<script>
  const ts = new TimeSeries({
    canvas: 'chart',
    initialView: 'last24',
    yAxisLabel: 'value',
    sources: [{
      'source-type': 'zabbix',
      url: '/zabbix/api_jsonrpc.php',   // relative = same origin = no CORS
      'auth-token': 'PASTE_YOUR_API_TOKEN',
      itemids: [12345],                 // from step 2
      'value-type': 0,                  // 0 = float, 3 = unsigned — must match the item
      name: 'CPU load',
    }],
  });

  TimeSeries.attachTooltip(ts);
  TimeSeries.attachLegend(ts);
</script>
```

Panning and zooming refetch as needed.

### CalDAV, end to end

1. **Create an app password** — e.g. Nextcloud: *Settings → Security → Create new app
   password*. Do not use your login password.
2. **Note the DAV base URL** — Nextcloud: `/remote.php/dav/`. With no `calendars` list the
   source discovers every calendar of that user itself.
3. **Drop the file on the same host** — anywhere on the server answering the DAV URL.

```html
<!DOCTYPE html>
<meta charset="utf-8">
<title>CalDAV — timeseries.js</title>
<canvas id="chart" style="width:100%;height:420px"></canvas>

<script src="https://cdn.jsdelivr.net/npm/@hgruber/timeseries.js@0.9/dist/timeseries.min.js"></script>
<script>
  const ts = new TimeSeries({
    canvas: 'chart',
    initialView: 'thisWeek',
    sources: [{
      'source-type': 'caldav',
      url: location.origin + '/remote.php/dav/',   // absolute, but still same-origin
      username: 'me',
      password: 'APP_PASSWORD',     // from step 1
      layout: 'calendar',
    }],
  });

  TimeSeries.attachTooltip(ts);
</script>
```

> The password sits in the page in clear text, so do not serve this file where others can
> read it. `demo/caldav-live.html` asks for credentials in a form instead and keeps them in
> `sessionStorage`.

---

## Cross-origin (CORS)

If the page cannot live on the same host as the API, the server has to allow the request
explicitly. In order of effort:

### 1. Same origin — no server change at all

Serve the page from the web server that answers the API. No preflight, no headers, nothing
to configure. Both recipes above do this, and it is the reason they exist.

### 2. Set the response headers

- **Zabbix** — `api_jsonrpc.php` must answer `OPTIONS` with `Access-Control-Allow-Origin`,
  `Access-Control-Allow-Methods: POST, OPTIONS`, and
  `Access-Control-Allow-Headers: Content-Type, Authorization`.
  A `*` in `Allow-Headers` does **not** cover `Authorization` — per the Fetch standard it
  has to be named explicitly.
- **CalDAV** — additionally `PROPFIND`, `REPORT` in `Allow-Methods` and `Depth` in
  `Allow-Headers`, and `OPTIONS` must be answered **before the auth layer**. Most servers
  answer it with `401`, which no header can rescue: a preflight must return 2xx. Requests go
  out with `credentials: 'omit'`, so a wildcard `Allow-Origin` is enough.

### 3. A local forwarder while developing (CalDAV only)

Needs the repo checkout. `npm run serve:proxy` adds a `/dav-proxy` route to the static
server that replays the request from Node, where the same-origin policy does not exist.

```js
{ 'source-type': 'caldav', url: 'https://dav.example.org/', proxy: '/dav-proxy?url=' }
```

The absolute target URL is appended URL-encoded. It binds to 127.0.0.1 only — a proxy to an
arbitrary target is an open relay — and `DAV_PROXY_ALLOW=host1,host2` narrows it further.

> `zabbix` has **no `proxy` option**; the forwarder is a CalDAV-only escape hatch. For
> Zabbix, solve CORS by placement or by headers.

---

## What is not built in yet

The [roadmap](../CLAUDE.md#data-source-roadmap) ranks candidates by ecosystem share and fit
to the plugin contract. Highest priority: **Prometheus** (`/api/v1/query_range`, which also
covers VictoriaMetrics, Thanos, Cortex and Mimir), **Home Assistant** (`/api/history`, bearer
token), and **InfluxDB** 1.x.

All three are ordinary [source plugins](plugins.md#custom-data-source) — nothing in the core
needs to change to add one.
