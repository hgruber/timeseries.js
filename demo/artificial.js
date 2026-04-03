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

