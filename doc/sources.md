# Data sources

A source is what puts data into the chart. Each entry in the constructor's `sources` array
is handed to the plugin named by its `source-type` key.

| `source-type` | Fetches from | Produces |
|---|---|---|
| `artificial` | nothing — the object *is* the data | whatever shape you wrote |
| `zabbix` | Zabbix JSON-RPC API | a ladder block (`quantile-bands` by default), two resolution tiers |
| `prometheus` | `/api/v1/query_range` (Prometheus, VictoriaMetrics, Thanos, Cortex, Mimir) | `multiline` blocks, two resolution tiers |
| `home-assistant` | `/api/history/period` (Bearer auth) | per-entity mix of `multiline` (numeric sensors) and `gantt` (binary/state sensors) |
| `influxdb` | InfluxQL `POST /query` (1.x) or Flux `POST /api/v2/query` (2.x) | `multiline` blocks, two resolution tiers |
| `caldav` | a CalDAV server | `gantt` spans |
| `websocket` (adapter) | a WebSocket feed (caller-supplied `transform`) | rolling `multiline` block, default 1 h window |
| `duckdb-wasm` (adapter) | an in-browser DuckDB (caller-supplied `db` or `dbFactory`) | whatever the SQL template returns, re-run on every viewport change |
| *(yours)* | anything | anything — see [Plugins](plugins.md) |

The six rows above the divider are built-in: they register themselves when the library loads.
The two adapter rows below are *opt-in* — they live in `src/adapters/` and must be
`import`ed explicitly so a page that does not use them does not pay for their bundle weight
(WebSocket pulls nothing extra; DuckDB-WASM expects the caller to ship `@duckdb/duckdb-wasm`
itself).

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
| `render` | `'quantile-bands'` | Which [ladder renderer](data-formats.md#the-five-renderers) draws the block: also `'quantile-steps'`, `'error-bars'`, `'candlestick'`, `'ohlc'`. Applies to **every** tier — the cross-fade groups blocks by type, so two of them would pop rather than dissolve. Anything that is not a ladder type warns and falls back |

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

## Prometheus

Zoom-adaptive: a fine tier (the requested `step`) and a coarse one (`step × step-factor`) are
held as two `multiline` blocks and dissolved into each other as you zoom. The same code path
serves Prometheus itself, VictoriaMetrics, Thanos, Cortex and Mimir — all of them expose
`/api/v1/query_range` with the same envelope.

```js
sources: [{
  'source-type': 'prometheus',
  url: 'http://prom.example.org:9090',     // may be relative; auth below
  token: 'ey…',                              // or `headers: { 'X-Scope-OrgID': '…' }`
  query: 'rate(node_cpu_seconds_total[1m])',
  // step: undefined,                  // auto-derive so each bucket is ≥ 2 px wide
  // 'step-factor': 10,                 // coarse tier = fine × this
  // render: 'multiline',               // or 'multipoint' / 'scatter'
  padding: 0.5,
  'series-colors': { cpu: '#2d6a9f' },
  name: 'CPU rate',
  // timeout: 20000,                   // ms; only set the key if you mean it
}]
```

| Option | Default | Notes |
|---|---|---|
| `url` | — | May be **relative** — it goes through `new URL(path, url)` |
| `token` | — | Bearer auth header (`Authorization: Bearer …`). Preferred: revocable |
| `username` / `password` | — | Basic auth |
| `headers` | — | Extra request headers — merged *after* auth, so an explicit `Authorization` overrides the calculated one. Use this for `X-Scope-OrgID` (Cortex/Mimir/Thanos) |
| `proxy` | — | Same-origin forwarder base URL, see [CORS](#cross-origin-cors) |
| `query` | — | A PromQL expression. The source wraps it into a `query_range` call; `/api/v1/query` (instant) is **not** used |
| `step` | auto | Bucket size in seconds. The source picks a value so each bucket is at least 2 px wide at the current zoom; an explicit value below that threshold is raised to the safe one with a `console.warn` |
| `'step-factor'` | `10` | The coarse tier uses `step × step-factor` |
| `render` | `'multiline'` | `'multiline'`, `'multipoint'` or `'scatter'`. Anything else falls back to `'multiline'` with a warning |
| `padding` | `0.5` | Fraction of the viewport prefetched either side |
| `'series-colors'` | — | Map of series key (the stable `metric` + sorted labels string, see below) → CSS colour |
| `name` | — | Plot name |
| `timeout` | `20000` ms | See the CalDAV note below — only pass the key if you set it |

After init, `source.client` is the `jpPrometheus` instance, `source.refresh()` re-evaluates
the current viewport, and `source.setOptions({…})` lets the live demo swap auth or query
without a full rebuild.

The series key is `metric + '\x1f' + label1=value1 + '\x1f' + label2=value2` with the labels
sorted, so two series that differ only in label order map to the same colour slot and a label
whose value contains `=` cannot collide with another label's name.

> **Empty `result: []`** renders as a block with `data: []` and no error — the chart simply
> shows the empty window. Same goes for Prometheus' literal `NaN` (Counter resets, "no data"):
> it is dropped during the fold, not silently zero-clamped.

---

## Home Assistant

Mixed-shape: numeric sensors become `multiline` blocks (`category: 'point'`), binary and state
sensors become `gantt` spans (`category: 'span'`). One source can carry both kinds on the same
chart — the routing decision is made per entity on every refresh.

```js
sources: [{
  'source-type': 'home-assistant',
  url: 'http://homeassistant.local:8123',
  token: '<long-lived access token>',         // HA accepts only Bearer auth
  'entity-ids': ['sensor.cpu_temp', 'binary_sensor.front_door'],
  padding: 0.5,
  'series-colors': { 'sensor.cpu_temp': '#2d6a9f', 'binary_sensor.front_door': '#cc7a2d' },
  name: 'Home Assistant',
}]
```

| Option | Default | Notes |
|---|---|---|
| `url` | — | Base URL, must be absolute |
| `token` | — | Bearer token (HA's "long-lived access token"). Required: HA does not accept basic auth |
| `entity-ids` | — | Array of entity ids. One block per id; pass the right ids for the chart you want |
| `padding` | `0.5` | Fraction of the viewport prefetched either side |
| `name` | `'Home Assistant'` | Plot name prefix; each block is `name · entity-id` |
| `'series-colors'` | — | Per-entity CSS colour map |
| `proxy` | — | Same-origin forwarder, see [CORS](#cross-origin-cors) |
| `timeout` | `20000` ms | Only pass the key if you set it |

### Routing numeric vs span

The source picks the renderer from the **last** state and its attributes:

- Finite numeric state → `multiline` (`category: 'point'`)
- `'on'` / `'off'` / `'unavailable'` / `'unknown'` / `'none'` / non-numeric state → `gantt`
  (`category: 'span'`)

When an entity's routing changes between fetches (a sensor flipped from numeric to `'on'`),
the old `plotId` is released via `removeData` and the new block is pushed with `pushData`. The
plot id sequence is preserved for the unchanged entities.

> **`attributes` is the common source of trouble.** HA collapses most attributes when you
> pass `minimal_response`, which is exactly what the source needs to disambiguate a sensor
> that has gone `unavailable` — so `jpHomeAssistant.history()` deliberately does **not** set
> `minimal_response`, even though it costs a few KB per row.

> **Basic auth is silently dropped.** The token is the only thing HA accepts. If a page is
> misconfigured with `username` / `password`, `jpHomeAssistant` emits a `console.warn` instead
> of waiting for an opaque 401 on the first request.

After init, `source.client` is the `jpHomeAssistant` instance. `source.refresh()` re-runs
against the current viewport; the source keeps a per-entity growing cache so a pan within the
already-fetched window replays without a round-trip.

---

## InfluxDB

Zoom-adaptive source that drives both **InfluxQL 1.x** and **Flux 2.x** from the same
constructor. The mode is decided by the `mode` option; the request body, content type and
response parser all swap accordingly.

```js
// InfluxQL (1.x) — form-encoded POST /query
sources: [{
  'source-type': 'influxdb',
  mode: '1x',
  url: 'http://influx.example.org:8086',
  token: '<token>',                          // or username + password
  db: 'telegraf',
  query: 'SELECT mean(usage_idle) FROM cpu WHERE host=~/web.*/ GROUP BY host, time(60s)',
  // step: undefined, 'step-factor': 10,
  padding: 0.5,
  'series-colors': { 'host=web01': '#2d6a9f' },
  name: 'CPU idle',
}]

// Flux (2.x) — JSON POST /api/v2/query, CSV response
sources: [{
  'source-type': 'influxdb',
  mode: '2x',
  url: 'https://us-east-1-1.aws.cloud2.influxdata.com',
  token: '<token>',
  org: 'my-org',
  bucket: 'my-bucket',
  query: 'from(bucket: "my-bucket") |> range(start: v.timeStart, stop: v.timeStop) '
       + '|> filter(fn: (r) => r._measurement == "cpu") |> mean()',
}]
```

| Option | Default | Notes |
|---|---|---|
| `url` | — | Absolute base URL |
| `mode` | `'1x'` | `'1x'` (InfluxQL) or `'2x'` (Flux). Anything else throws on construction |
| `db` (1.x) | — | Database name; required for 1.x |
| `org` (2.x) | — | Organisation; required for 2.x |
| `bucket` (2.x) | — | Bucket name; required for 2.x |
| `token` | — | `Authorization: Token <token>`. 2.x accepts only this; 1.x falls back to basic |
| `username` / `password` | — | Basic auth for 1.x; ignored in 2.x |
| `query` | — | The full query. 1.x has its time window appended automatically; 2.x relies on `range(start: v.timeStart, stop: v.timeStop)` |
| `step` | auto | Bucket size in seconds; see the Prometheus section for the 2-px threshold |
| `'step-factor'` | `10` | Coarse tier multiplier |
| `render` | `'multiline'` | `'multiline'`, `'multipoint'`, or `'quantile-bands'` |
| `padding` | `0.5` | Fraction of the viewport prefetched either side |
| `'series-colors'` | — | Map of series key (the joined tags, see below) → CSS colour |
| `name` | — | Plot name |
| `proxy` | — | Same-origin forwarder |
| `timeout` | `20000` ms | Only pass the key if you set it |

The series key is `tag1=value1\x1ftag2=value2` with the tags sorted; measurements without tags
collapse to just the measurement name, so `series_colors` keys match `host=web01` and not
`host="web01"`.

> **2.x with `Accept: application/json` does not work.** The Flux endpoint streams CSV when
> asked nicely (with `dialect: {header: true}`), and a JSON parse of that stream fails. The
> client therefore requests `text/csv` and parses the annotated CSV (with `#group` /
> `#datatype` comment rows) itself.

> **`results[0].error` is a server error**, not an empty envelope. The client throws with
> code 502 and the source pushes an empty block rather than waiting for a follow-up request.

After init, `source.client` is the `jpInfluxdb` instance; `source.refresh()` re-evaluates the
viewport and `source.setOptions({mode, db, org, bucket, …})` lets the live demo flip between
1.x and 2.x without rebuilding the chart.

---

## WebSocket (adapter)

Maintains a rolling `multiline` `PointSeries` window of the most recent `windowMs`
milliseconds of data received from a WebSocket endpoint. The adapter is **opt-in** — it lives
in `src/adapters/websocket.js` and must be imported explicitly so a page that does not use
it does not pay for the registration:

```js
import TimeSeries from '@hgruber/timeseries.js';
import '@hgruber/timeseries.js/src/adapters/websocket.js';   // registers the source
```

```js
sources: [{
  'source-type': 'websocket',
  url: 'wss://example.com/metrics',
  windowMs: 30 * 60 * 1000,                // 30-minute rolling window
  transform(msg) {                           // msg = the parsed JSON object the server sent
    return {
      t: msg.timestamp_ms,
      values: { cpu: msg.cpu, mem: msg.mem }
    };
  }
}]
```

| Option | Default | Notes |
|---|---|---|
| `url` | — | `ws://` or `wss://` endpoint. Required |
| `windowMs` | `3600000` (1 h) | Buffer size in ms. Points older than `now - windowMs` are trimmed on every tick |
| `transform` | — | `(parsedMsg) → { t: ms, values: { seriesId: number } }`. Required: the wire format is yours |

The adapter buffers in-memory and trims on every push — pan and zoom do not reopen the
socket. After init, `source._ws` is the underlying `WebSocket` so the page can close it on
teardown.

> **Bring your own server.** There is no synthetic fallback: a static demo page cannot fake a
> live WS feed without a producer in the same origin. See `demo/websocket.html` for a
> copy-pasteable wiring example.

---

## DuckDB-WASM (adapter)

Re-runs a SQL query against an in-browser DuckDB on every viewport change. The SQL is a
template with three named placeholders substituted per fetch:

- `:tmin` — viewport start, milliseconds (integer)
- `:tmax` — viewport end, milliseconds (integer)
- `:mspp` — milliseconds per pixel — use it for your `GROUP BY` bucket size so the result is
  exactly one row per pixel

External dependency: the page must initialise [`@duckdb/duckdb-wasm`](https://duckdb.org/docs/api/wasm/overview.html)
itself and hand the adapter the resulting `AsyncDuckDB` instance via `db`, or pass a
`dbFactory` that returns one on first use. The adapter is **opt-in** — it lives in
`src/adapters/duckdb-wasm.js` and must be imported explicitly so a page that does not use
it does not pull in DuckDB's bundle:

```js
import TimeSeries from '@hgruber/timeseries.js';
import '@hgruber/timeseries.js/src/adapters/duckdb-wasm.js';   // registers the source
```

```js
sources: [{
  'source-type': 'duckdb-wasm',
  dbFactory: () => initMyDuckDb(),              // returns a connected AsyncDuckDB
  query: `
    SELECT epoch_ms(time_bucket(INTERVAL (CAST(:mspp AS INT) || ' ms'), ts)) AS t,
           avg(cpu) AS cpu, avg(mem) AS mem
    FROM   metrics
    WHERE  ts BETWEEN to_timestamp(:tmin / 1000.0)
                  AND to_timestamp(:tmax / 1000.0)
    GROUP BY 1
    ORDER BY 1
  `,
  transform(rows) {
    var data = rows.map(r => ({
      t: r.t,
      values: { cpu: r.cpu, mem: r.mem }
    }));
    var vals = data.flatMap(p => Object.values(p.values));
    return {
      category: 'point', type: 'multiline',
      tmin: data[0]?.t ?? 0, tmax: data[data.length - 1]?.t ?? 0,
      min: Math.min(...vals), max: Math.max(...vals),
      series: [{ id: 'cpu', name: 'CPU %' }, { id: 'mem', name: 'Mem %' }],
      data
    };
  }
}]
```

| Option | Default | Notes |
|---|---|---|
| `db` | — | A connected `AsyncDuckDB` instance. Mutually exclusive with `dbFactory` |
| `dbFactory` | — | `() => Promise<AsyncDuckDB>` — called once, the resolved connection is cached |
| `query` | — | SQL template with `:tmin` / `:tmax` / `:mspp` placeholders. Required |
| `transform` | — | `(rows) → plot`. `rows` is an array of plain `{ column: value }` objects (the Arrow table, dereferenced). Must return a valid `BinnedSeries` or `PointSeries` — see [data-formats](data-formats.md) |

The adapter runs the query once on construction and again on every viewport change (pan,
zoom, resize). Connection failures and SQL errors are reported via `console.warn` and the
chart keeps the previous block — it does not clear the screen on a transient backend
hiccup.

> **Bring your own DuckDB.** DuckDB-WASM is several megabytes and the library deliberately
> does not pull it in. See `demo/duckdb-wasm.html` for a complete wiring example.

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

<script src="https://cdn.jsdelivr.net/npm/@hgruber/timeseries.js@0.10/dist/timeseries.min.js"></script>
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

<script src="https://cdn.jsdelivr.net/npm/@hgruber/timeseries.js@0.10/dist/timeseries.min.js"></script>
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

The [roadmap](internals/roadmap.md#data-source-roadmap) ranks candidates by ecosystem share and
fit to the plugin contract. The eight built-ins cover the common back-ends (six core sources
plus the WebSocket and DuckDB-WASM adapters); anything beyond them is a custom
[source plugin](plugins.md#custom-data-source) — the core does not change to add one.
