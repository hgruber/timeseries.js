// WebSocket data source adapter for timeseries.js
//
// Maintains a rolling PointSeries window of the most recent `windowMs`
// milliseconds of data received from a WebSocket endpoint.
//
// Source config fields:
//   type:        'websocket'
//   source-type: 'websocket'
//   url:         string          WebSocket URL, e.g. 'ws://host/feed'
//   windowMs:    number          Rolling window size in ms (default: 3 600 000 = 1 h)
//   transform:   function(msg)   Transform a parsed JSON message into { t, values }
//                                where t is ms timestamp and values is { seriesId: number }
//
// Example:
//   {
//     'source-type': 'websocket',
//     url: 'ws://localhost:9000/metrics',
//     windowMs: 1800000,
//     transform(msg) {
//       return { t: msg.timestamp_ms, values: { cpu: msg.cpu, mem: msg.mem } };
//     }
//   }

import { registerSource } from '../sources.js';

function buildPlot(buffer) {
  if (buffer.length === 0) {
    return { category: 'point', type: 'multiline', tmin: 0, tmax: 0, min: 0, max: 0, series: [], data: [] };
  }
  var min = Infinity, max = -Infinity;
  var seriesIds = Object.keys(buffer[0].values);
  for (const pt of buffer) {
    for (const v of Object.values(pt.values)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return {
    category: 'point',
    type: 'multiline',
    tmin: buffer[0].t,
    tmax: buffer[buffer.length - 1].t,
    min: min,
    max: max,
    series: seriesIds.map(id => ({ id: id, name: id })),
    data: buffer,
  };
}

registerSource({
  type: 'websocket',
  init(source, callbacks) {
    var windowMs = source.windowMs || 3600000;
    var buffer = [];
    var id = null;
    var ws = new WebSocket(source.url);

    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      var pt = source.transform(msg);
      if (!pt || pt.t == null) return;

      buffer.push(pt);

      // Trim points older than the window
      var cutoff = Date.now() - windowMs;
      var start = 0;
      while (start < buffer.length && buffer[start].t < cutoff) start++;
      if (start > 0) buffer = buffer.slice(start);

      var plot = buildPlot(buffer);
      if (id === null) id = callbacks.pushData(plot);
      else callbacks.replaceData(id, plot);
      callbacks.requestRedraw();
    };

    ws.onerror = function (e) {
      console.warn('TimeSeries WebSocket error', e);
    };

    ws.onclose = function () {
      console.warn('TimeSeries WebSocket closed', source.url);
    };

    // Expose ws so the caller can close it if needed
    source._ws = ws;
  }
});
