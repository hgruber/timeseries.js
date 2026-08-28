/* global TimeSeries */
function gauss(x, a, s) {
  return Math.exp(-(x - a) * (x - a) / s);
}

var artificialData = {}
for (var j = 0; j < 1440; j++) {
  artificialData[j] = {
    0: 67 * gauss(j, 1220, 1e5) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 2),
    1: 92 * gauss(j, 400, 1e5) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 3),
    2: 75 * gauss(j, 1040, 1e5) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 2),
    3: 198 * gauss(j, 800, 6e5) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 5),
    4: 311 * gauss(j, 680, 9e5) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 9),
    5: (400 * gauss(j, 400, 1e5) + 600 * gauss(j, 1000, 1e5)) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 13),
  }
}

var _intervalStart = +new Date(new Date(Date.now() - 86400000).toDateString()) / 1000;
var _intervalEnd   = +new Date(new Date().toDateString()) / 1000;

var artificial = {
  "name": "example stacked bars",
  "type": "multibar",
  "source-type": "artificial",
  "max": 1400,
  "min": 0,
  "sum": 1624392,
  "count": 1440,
  "interval": 60,
  "interval_start": _intervalStart,
  "interval_end": _intervalEnd,
  "data": artificialData
}

// ── Two resolution tiers of the same data (zoom-adaptive cross-fade) ─────────
//
// The core keeps blocks of differing `interval` side by side and dissolves
// between them as the bars cross ~2px wide, so the day view shows readable
// hourly bars that resolve into the 1440 minute bars as you zoom in.
//
// A separate object rather than `artificial` itself: pushData stores the block
// by reference, and `artificial` is already driving the gallery card below —
// two charts must not share mutable render state (`_fade`, `interval_end`).
//
// `mean`, not the default `sum`: the point here is the dissolve, and averaging
// keeps both tiers on the same y-scale so the eye follows the bar widths rather
// than a change of unit.

var artificialFine = Object.assign({}, artificial, {
  name: "example stacked bars (1 min)",
});

var artificialHourly = Object.assign(
  TimeSeries.rollupBinned(artificialFine, 3600, { agg: 'mean' }),
  { "source-type": "artificial", name: "example stacked bars (1 h)" },
);

// ── BinnedSeries variants (same slot-indexed data, different renderer type) ──

var artificialMultiline = Object.assign({}, artificial, {
  name: "example multiline (BinnedSeries)",
  type: "multiline",
});

var artificialMultipoint = Object.assign({}, artificial, {
  name: "example multipoint (BinnedSeries)",
  type: "multipoint",
});

// ── PointSeries variants (explicit timestamp per point) ───────────────────────
// Uses series 0, 2, 4 from the slot data (three distinct Gaussian peaks).

var _t0   = _intervalStart * 1000; // ms
var _step = 60000;                 // 60 s per slot in ms
var _pmax = 0;
var artificialPointData = [];

for (var _j = 0; _j < 1440; _j++) {
  var _va = artificialData[_j][0];
  var _vb = artificialData[_j][2];
  var _vc = artificialData[_j][4];
  if (_va > _pmax) _pmax = _va;
  if (_vb > _pmax) _pmax = _vb;
  if (_vc > _pmax) _pmax = _vc;
  artificialPointData.push({ t: _t0 + _j * _step, values: { a: _va, b: _vb, c: _vc } });
}

var _pointBase = {
  category: "point",
  "source-type": "artificial",
  tmin: _t0,
  tmax: _t0 + 1440 * _step,
  min: 0,
  max: Math.ceil(_pmax),
  series: [
    { id: "a", name: "Series 0" },
    { id: "b", name: "Series 2" },
    { id: "c", name: "Series 4" },
  ],
};

var artificialPointLine = Object.assign({}, _pointBase, {
  name: "example multiline (PointSeries)",
  type: "multiline",
  data: artificialPointData,
});

// Scatter: every 10th point for visual clarity
var artificialPointScatter = Object.assign({}, _pointBase, {
  name: "example scatter (PointSeries)",
  type: "scatter",
  data: artificialPointData.filter(function (_, i) { return i % 10 === 0; }),
});

// ── Ladder variants (an array of percentile values per slot) ──────────────────
//
// One hourly ladder over series 5's day curve: 60 samples per hour scattered
// around that hour's mean, reduced to the 5th, 25th, 50th, 75th and 95th
// percentile. Four renderers draw this very same block four different ways,
// which is the point of showing them side by side — quantile-bands connects
// the hours, the other three stay inside the bin the values were measured in
// and claim nothing about the time between.
//
// The samples are scattered rather than taken straight from the minute data:
// within one hour that curve barely moves, so the real ladder collapses to a
// hairline and there is no band left to look at.

function _pctOf(sorted, p) {
  var pos = (sorted.length - 1) * (p / 100);
  var lo = Math.floor(pos);
  var hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

var _ladderData = {};
var _ladderMin = Infinity;
var _ladderMax = -Infinity;

for (var _h = 0; _h < 24; _h++) {
  var _base = 0;
  for (var _m = 0; _m < 60; _m++) _base += artificialData[_h * 60 + _m][5];
  _base /= 60;
  var _hourVals = [];
  for (var _s = 0; _s < 60; _s++) {
    // Three uniforms averaged approximate a normal, so the fan is dense around
    // the median and thin in the tails — which is what the band alphas assume.
    var _noise = (Math.random() + Math.random() + Math.random()) / 3 - 0.5;
    _hourVals.push(Math.max(0, _base * (1 + 0.8 * _noise)));
  }
  _hourVals.sort(function (a, b) { return a - b; });
  var _rungs = [5, 25, 50, 75, 95].map(function (p) { return _pctOf(_hourVals, p); });
  if (_rungs[0] < _ladderMin) _ladderMin = _rungs[0];
  if (_rungs[4] > _ladderMax) _ladderMax = _rungs[4];
  _ladderData[_h] = { load: _rungs };
}

var _ladderBase = {
  "source-type": "artificial",
  percentiles: [5, 25, 50, 75, 95],
  interval: 3600,
  interval_start: _intervalStart,
  interval_end: _intervalStart + 24 * 3600,
  count: 24,
  min: Math.floor(_ladderMin),
  max: Math.ceil(_ladderMax),
  series_colors: { load: '#2d6a9f' },
  data: _ladderData,
};

var artificialBands = Object.assign({}, _ladderBase, {
  name: "example quantile-bands (BinnedSeries)",
  type: "quantile-bands",
});

var artificialSteps = Object.assign({}, _ladderBase, {
  name: "example quantile-steps (BinnedSeries)",
  type: "quantile-steps",
});

var artificialErrorBars = Object.assign({}, _ladderBase, {
  name: "example error-bars (BinnedSeries)",
  type: "error-bars",
});

var artificialCandles = Object.assign({}, _ladderBase, {
  name: "example candlestick (BinnedSeries)",
  type: "candlestick",
});

// `connect: false` drops the vertical risers, so the segments stand free and the
// chart says nothing at all about the jump from one bin to the next.
var artificialStepsOpen = Object.assign({}, _ladderBase, {
  name: "example quantile-steps, connect: false",
  type: "quantile-steps",
  connect: false,
});

// ── True OHLC candles (the `roles` opt-in) ────────────────────────────────────
//
// A percentile ladder has no direction, so nothing to colour rising against
// falling. A random walk of open/high/low/close does, and `roles` names which
// array index is which: rising bins are drawn hollow, falling ones filled.

var _ohlcData = {};
var _ohlcMin = Infinity;
var _ohlcMax = -Infinity;
var _price = 100;

// The y-axis includes zero, so a series drifting a few percent around 100 draws
// as a flat line of specks at the top. The walk is deliberately volatile enough
// that the bodies are readable against a 0-based axis.
for (var _oh = 0; _oh < 24; _oh++) {
  var _open = _price;
  var _close = Math.max(10, _open * (1 + (Math.random() - 0.47) * 0.34));
  var _high = Math.max(_open, _close) * (1 + Math.random() * 0.06);
  var _low = Math.min(_open, _close) * (1 - Math.random() * 0.06);
  _ohlcData[_oh] = { price: [_open, _high, _low, _close] };
  if (_low < _ohlcMin) _ohlcMin = _low;
  if (_high > _ohlcMax) _ohlcMax = _high;
  _price = _close;
}

var artificialCandlesOHLC = {
  "source-type": "artificial",
  name: "example candlestick (OHLC via roles)",
  type: "candlestick",
  percentiles: ["open", "high", "low", "close"],
  roles: { open: 0, high: 1, low: 2, close: 3 },
  interval: 3600,
  interval_start: _intervalStart,
  interval_end: _intervalStart + 24 * 3600,
  count: 24,
  min: Math.floor(_ohlcMin),
  max: Math.ceil(_ohlcMax),
  series_colors: { price: '#2d6a9f' },
  data: _ohlcData,
};

// ── Butterfly stacked variant ─────────────────────────────────────────────────
// Same multibar data, but series 1, 3, 5 stack DOWN from y=0 while 0, 2, 4
// stack UP. The renderer reads `series_directions` to decide direction.
var artificialButterfly = Object.assign({}, artificial, {
  name: "example butterfly (BinnedSeries)",
  series_directions: { 1: 'down', 3: 'down', 5: 'down' },
});

