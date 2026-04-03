// DuckDB WASM data source adapter for timeseries.js
//
// Queries a DuckDB WASM database on every viewport change.
// The SQL query is a template with named placeholders replaced per-fetch:
//   :tmin    current viewport start in milliseconds (integer)
//   :tmax    current viewport end   in milliseconds (integer)
//   :mspp    milliseconds per pixel (1 / ppms) — use for GROUP BY bucketing
//
// External dependency: @duckdb/duckdb-wasm must be initialised and accessible
// via source.db (a DuckDB AsyncDuckDB instance) or source.dbFactory (an async
// function that returns one).  See https://duckdb.org/docs/api/wasm/overview.html
//
// Source config fields:
//   type:        'duckdb-wasm'
//   source-type: 'duckdb-wasm'
//   db:          AsyncDuckDB instance  (mutually exclusive with dbFactory)
//   dbFactory:   async function()→AsyncDuckDB  (called once, result is cached)
//   query:       string               SQL template with :tmin/:tmax/:mspp placeholders
//   transform:   function(rows)→plot  Convert query result rows to a plot object.
//                                     rows is an Array of plain objects (column→value).
//                                     Must return a valid BinnedSeries or PointSeries.
//
// Example (PointSeries):
//   {
//     'source-type': 'duckdb-wasm',
//     dbFactory: () => myDuckDBInit(),
//     query: `
//       SELECT epoch_ms(time_bucket(INTERVAL (CAST(:mspp AS INT) || ' ms'), ts)) AS t,
//              avg(cpu) AS cpu, avg(mem) AS mem
//       FROM metrics
//       WHERE ts BETWEEN to_timestamp(:tmin / 1000.0)
//                    AND to_timestamp(:tmax / 1000.0)
//       GROUP BY 1 ORDER BY 1
//     `,
//     transform(rows) {
//       var data = rows.map(r => ({ t: r.t, values: { cpu: r.cpu, mem: r.mem } }));
//       var vals = data.flatMap(p => Object.values(p.values));
//       return {
//         category: 'point', type: 'multiline',
//         tmin: data[0]?.t ?? 0, tmax: data[data.length-1]?.t ?? 0,
//         min: Math.min(...vals), max: Math.max(...vals),
//         series: [{ id: 'cpu', name: 'CPU %' }, { id: 'mem', name: 'Mem %' }],
//         data,
//       };
//     }
//   }

import { registerSource } from '../sources.js';

registerSource({
  type: 'duckdb-wasm',
  init(source, callbacks) {
    var id = null;
    var dbPromise = null;
    var connPromise = null;

    function getConn() {
      if (connPromise) return connPromise;
      var dbp = source.db ? Promise.resolve(source.db) : source.dbFactory();
      dbPromise = dbp;
      connPromise = dbp.then(db => db.connect());
      return connPromise;
    }

    async function fetchAndRender(tmin, tmax, ppms) {
      var mspp = ppms > 0 ? Math.round(1 / ppms) : 1000;
      var sql = source.query
        .replace(/:tmin/g, Math.floor(tmin))
        .replace(/:tmax/g, Math.ceil(tmax))
        .replace(/:mspp/g, mspp);

      var conn;
      try {
        conn = await getConn();
      } catch (e) {
        console.warn('TimeSeries duckdb-wasm: connection failed', e);
        return;
      }

      var result;
      try {
        result = await conn.query(sql);
      } catch (e) {
        console.warn('TimeSeries duckdb-wasm: query failed', e, sql);
        return;
      }

      // Convert Arrow table to plain rows array
      var rows = result.toArray().map(row => Object.fromEntries(
        result.schema.fields.map((f, i) => [f.name, row[i]])
      ));

      var plot;
      try {
        plot = source.transform(rows);
      } catch (e) {
        console.warn('TimeSeries duckdb-wasm: transform failed', e);
        return;
      }

      if (id === null) id = callbacks.pushData(plot);
      else callbacks.replaceData(id, plot);
      callbacks.requestRedraw();
    }

    // Initial fetch using current viewport
    var vp = callbacks.getViewport();
    fetchAndRender(vp.tmin, vp.tmax, vp.ppms);

    // Re-fetch whenever the viewport changes
    callbacks.onViewportChange(fetchAndRender);
  }
});
