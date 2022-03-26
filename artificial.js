function gauss(x, a, s) {
  return Math.exp(-(x - a) * (x - a) / s);
}

var a = {}
for (j = 0; j < 1440; j++) {
  a[j] = {
    "0": 67 * gauss(j, 1220, 1e5) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 2),
    "1": 92 * gauss(j, 400, 1e5) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 3),
    "2": 75 * gauss(j, 1040, 1e5) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 2),
    "3": 198 * gauss(j, 800, 6e5) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 5),
    "4": 311 * gauss(j, 680, 9e5) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 9),
    "5": (400 * gauss(j, 400, 1e5) + 600 * gauss(j, 1000, 1e5)) * ( 1 + gauss(Math.floor(Math.random() * 4), 0, 1) / 13),
  }
}

var data = [];
data[0] = {
  "name": "example stacked bars",
  "type": "multibar",
  "max": 1400,
  "min": 0,
  "sum": 1624392,
  "count": 1440,
  "interval": 60,
  "interval_start": +new Date(new Date(Date.now() - 86400000).toDateString())/1000,
  "interval_end": +new Date(new Date().toDateString())/1000,
  "data": a
}
