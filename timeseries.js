var canvas = document.getElementById('timeseries');
var c = canvas.getContext('2d');
canvas.width = canvas.clientWidth;
canvas.height = canvas.clientHeight;
var style = window.getComputedStyle(canvas);
var BB = canvas.getBoundingClientRect();
var offset = {
  x: BB.left,
  y: BB.top
}
var startDragX = 0,
  startTmin, startTmax;
var margin = {
  top: 50,
  right: 12,
  bottom: 70,
  left: 70
}
var nls = 'default';
var plotWidth = canvas.width - margin.left - margin.right;
var plotHeight = canvas.height - margin.top - margin.bottom;
var now = Date.now();
var follow_timers = 0;
var tmax = now;
var tmin = tmax - 86400000;
var ymin = 0;
var ymax = 1;
var zf = 0.1; // the smaller the smoother the wheel zoom
var pixels = plotWidth / (tmax - tmin); // pixels per millisecond
var mspp = 1. / pixels; // milliseconds per pixels

var f = {
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000,
  mon: 2678400000
}

var grid = {
  milliseconds: {},
  seconds: {},
  minutes: {},
  hours: {},
  days: {},
  months: {},
  years: {},
  decades: {},
  centuries: {},
  millenia: {}
}

c.font = style.font;
var font_height = c.measureText('2').actualBoundingBoxAscent;
var dvtl = 10; // the minimal pixel distance for vertical time lines
var dtl = 3 * font_height; // the minimal pixel distance for time labels

var part1000 = [1, 5, 10, 50, 100, 500];
var part60 = [1, 5, 10, 15, 30];
var part24 = [1, 2, 4, 12];
var part10 = [1, 2, 5];

//
// create possible labels to create array with maximum length
// stored in labels.day_pixels
// this can vary with font-size as well as with language settings
//
var labels = {}

labels.day = [{
  weekday: 'long',
  day: 'numeric',
  month: 'numeric'
}, {
  weekday: 'short',
  day: 'numeric'
}, {
  day: 'numeric'
}]

labels.month = [{
  month: 'long',
  year: 'numeric'
}, {
  month: 'long',
  year: '2-digit'
}, {
  month: 'short',
  year: '2-digit'
}, {
  month: 'short'
}, {
  month: 'narrow'
}]

labels.year = [{
  year: 'numeric'
}]

labels.year_pixels = new Array(labels.year.length).fill(36);

labels.day_pixels = new Array(labels.day.length).fill(0);
for (var i = 0; i < 7; i++) {
  labels.day.forEach((format, j) => {
    l = c.measureText(new Date((i + 355) * 86400000).toLocaleString(nls, format)).width;
    if (l > labels.day_pixels[j]) labels.day_pixels[j] = l;
  });
}

labels.month_pixels = new Array(labels.month.length).fill(0);
for (var i = 0; i < 12; i++) {
  labels.month.forEach((format, j) => {
    l = c.measureText(new Date((i * 30 + 5) * 86400000).toLocaleString(nls, format)).width;
    if (l > labels.month_pixels[j]) labels.month_pixels[j] = l;
  });
}

function label(date, format, size) {
  for (var i = 0; i < labels[format].length; i++)
    if (size > labels[format + '_pixels'][i]) return date.toLocaleString(nls, labels[format][i]);
  return '';
}

function vertical_label(t, x, y) {
  text = String(t.getHours()) + ':' + String(t.getMinutes()).padStart(2, '0');
  if (t % f.m > 0) text = ':' + String(t.getSeconds()).padStart(2, '0');
  if (t % 1000 > 0) text += '.' + String(t.getMilliseconds()).padStart(3, '0');
  if (x >= margin.left) rotateText(text, x, y);
}

function vertical_line(t, color) {
  var x = X(+t);
  c.strokeStyle = color;
  c.beginPath();
  c.moveTo(x, margin.top);
  c.lineTo(x, margin.top + plotHeight);
  c.stroke();
}


/////////////////////
// End of settings //
/////////////////////

function timer(f, t) {
  follow_timers++;
  setTimeout(f, t);
  //console.log('Timer ' + follow_timers + ' set for ' + t + ' milliseconds');
}

function follow_view() {
  follow_timers--;
  now = Date.now();
  if (tmax - mspp < now && now < tmax + 10 * mspp) {
    tmin = tmin + now - tmax;
    tmax = now;
  } else if (now > tmax) return;
  if (now < rT(0)) {
    timer(follow_view, now - rT(0));
    return;
  } else {
    t = mspp;
    if (mspp > 5000) t = 5000;
    timer(follow_view, t);
  }
  plotAll();
}

function plotAll() {
  prepare_grid();
  background();
  plotData();
  frame();
  yAxis();
  redLine();
  console.log('plot finished: ' + follow_timers);
  //console.log(grid);
  if (follow_timers < 0) timer(follow_view, 1000);
}

window.onresize = function() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  plotWidth = canvas.width - margin.left - margin.right;
  plotHeight = canvas.height - margin.top - margin.bottom;
  plotAll();
}

canvas.onmousedown = function(e) {
  // is in canvas ...
  console.log(e.clientX, e.clientY)
  startDragX = e.clientX;
  startTmin = tmin;
  startTmax = tmax;
}

canvas.onmousemove = function(e) {
  if (startDragX == 0) return;
  var move = (startDragX - e.clientX) / plotWidth * (tmax - tmin);
  tmin = startTmin + move;
  tmax = startTmax + move;
  plotAll();
}

canvas.onmouseup = function(e) {
  startDragX = 0;
}

canvas.onmouseout = function(e) {
  starDragX = 0;
}

canvas.onwheel = function(e) {
  if (pixels > 25 && e.deltaY < 0) return;
  if (pixels < 6e-9 && e.deltaY > 0) return;
  var r = tmax - tmin;
  var lr = (e.clientX - offset.x - margin.left) / plotWidth;
  var rr = 1 - lr;
  if (e.deltaY > 0) {
    tmin -= zf * lr * r;
    tmax += zf * rr * r;
  } else {
    tmin += zf * lr * r;
    tmax -= zf * rr * r;
  }
  plotAll();
}

// how many tic to use for a given interval
// p is defined array part10, part24 or part60
// t is timeinterval in ms
// d is minimum pixel distance allowed between tics
function time_part(p, t, d) {
  for (var pp in p)
    if (pixels * t * p[pp] > d) return p[pp];
}

function prepare_grid() {
  pixels = plotWidth / (tmax - tmin); // pixels per millisecond
  mspp = 1. / pixels; // milliseconds per pixels
  dtm = new Date(tmax);

  // milliseconds
  var part = time_part(part1000, 1, dvtl);
  var partl = time_part(part1000, 1, dtl);
  grid.milliseconds.items = [];
  if (part)
    for (var t = Math.floor(tmin); t < Math.ceil(tmax); t++) {
      if (t % part == 0) grid.milliseconds.items.push({
        tm: new Date(t),
        label: (t % partl == 0)
      });
    }

  // seconds
  part = time_part(part60, f.s, dvtl);
  partl = time_part(part60, f.s, dtl);
  grid.seconds.items = [];
  if (part)
    for (var t = Math.floor(tmin / f.s) * f.s; t < tmax; t += f.s) {
      var d = new Date(t);
      s = d / 1000;
      if (s % part == 0) grid.seconds.items.push({
        tm: d,
        label: (s % partl == 0)
      });
    }

  // minutes
  part = time_part(part60, f.m, dvtl);
  partl = time_part(part60, f.m, dtl);
  grid.minutes.items = [];
  if (part)
    for (var t = Math.floor(tmin / f.m) * f.m; t < tmax; t += f.m) {
      var d = new Date(t);
      var m = d.getMinutes();
      if (m % part == 0) grid.minutes.items.push({
        tm: d,
        label: (m % partl == 0)
      });
    }

  // hours
  grid.hours.items = [];
  part = time_part(part24, f.h, dvtl);
  partl = time_part(part24, f.h, dtl);
  var ds = f.h * part;
  if (part)
    for (var t = Math.floor(tmin / f.h) * f.h; t < tmax; t += f.h) {
      var d = new Date(t);
      var h = d.getHours();
      if (h % part == 0) grid.hours.items.push({
        tm: d,
        label: (h % partl == 0)
      });
    }

  // days
  grid.days.items = [];
  space = pixels * f.d;
  if (space > dvtl)
    for (var t = new Date(new Date(tmax).toDateString()); t >= tmin - f.d; t = new Date(new Date(t - 12 * f.h).toDateString())) {
      if (t < tmin) x = margin.left;
      else x = X(t);
      l = grid.days.items.length;
      if (l) len = grid.days.items[l - 1].x - x;
      else len = canvas.width - margin.right - x;
      grid.days.items.push({
        tm: t,
        date: label(t, 'day', len),
        x: x,
        len: len
      });
    }

  // months
  grid.months.items = [];
  space = pixels * f.d * 31;
  dm = dtm;
  if (space > dvtl) {
    while (true) {
      t = new Date(Date.parse(dm.getFullYear() + '-' + (dm.getMonth() + 1) + '-1 00:00'));
      if (t < tmin) x = margin.left;
      else x = X(t);
      l = grid.months.items.length;
      if (l) len = grid.months.items[l - 1].x - x;
      else len = canvas.width - margin.right - x;
      grid.months.items.push({
        tm: t,
        date: label(t, 'month', len),
        x: x,
        len: len
      });
      dm = new Date(t - 1);
      if (dm < tmin) break;
    }
  }

  // years
  dm = dtm;
  grid.years.items = [];
  space = pixels * f.d * 365;
  if (space > dvtl) {
    for (t = new Date(Date.parse(dm.getFullYear() + '-1-1 00:00')); t >= tmin - 366 * f.d; t = new Date(Date.parse(new Date(t - 70 * f.d).getFullYear()+ '-1-1 00:00'))) {
      if (t < tmin) x = margin.left;
      else x = X(t);
      l = grid.years.items.length;
      if (l) len = grid.years.items[l - 1].x - x;
      else len = canvas.width - margin.right - x;
      grid.years.items.push({
        tm: t,
        date: label(t, 'year', len),
        x: x,
        len: len
      });
    }
  }
}

function X(t) {
  return (t - tmin) / (tmax - tmin) * plotWidth + margin.left;
}

function rT(x) {
  return (x - margin.left) / plotWidth * (tmax - tmin) + tmin;
}

function Y(y) {
  return (ymax - y) / (ymax - ymin) * plotHeight + margin.top;
}

function rY(Y) {
  return ymax - (Y - margin.top) / plotHeight * (ymax - ymin);
}

function rotateText(text, x, y) {
  c.save();
  c.translate(x, y);
  c.rotate(-Math.PI / 2);
  c.fillText(text, 0, 0);
  c.restore();
}

function background() {
  c.fillStyle = 'white';
  c.fillRect(margin.left, margin.top, plotWidth, plotHeight);
  grid.months.items.forEach((item) => {
    mo = item.tm.getMonth();
    if (mo % 2) c.fillStyle = '#bbf';
    else c.fillStyle = '#eee';
    c.fillRect(item.x, margin.top, item.len, plotHeight);
    vertical_line(item.tm, '#888');
  });
  grid.days.items.forEach((item) => {
    wd = item.tm.getDay();
    if (wd == 0 || wd == 6) c.fillStyle = '#fbbb';
    else {
      if (wd % 2) c.fillStyle = '#eeeb';
      else c.fillStyle = '#dddb';
    }
    c.fillRect(item.x, margin.top, item.len, plotHeight);
    vertical_line(item.tm, '#888');
  });
  grid.hours.items.forEach((item) => {
    vertical_line(item.tm, '#aaa')
  });
  grid.minutes.items.forEach((item) => {
    vertical_line(item.tm, '#aaa')
  });
  grid.seconds.items.forEach((item) => {
    vertical_line(item.tm, '#aaa')
  });
  grid.milliseconds.items.forEach((item) => {
    vertical_line(item.tm, '#aaa')
  });
  if (now >= tmax) return;
  if (now < tmin) x = margin.left;
  else x = X(now);
  c.fillStyle = '#aaaa';
  c.fillRect(x, margin.top, plotWidth, plotHeight);
}

function frame() {
  c.fillStyle = style.backgroundColor;
  c.fillRect(0, 0, canvas.width, margin.top);
  c.fillRect(0, margin.top, margin.left, canvas.height - margin.top);
  c.fillRect(margin.left, canvas.height - margin.bottom, canvas.width - margin.left, margin.bottom);
  c.fillRect(canvas.width - margin.right, margin.top, margin.right, plotHeight);
  c.beginPath();
  c.moveTo(margin.left, margin.top);
  c.lineTo(canvas.width - margin.right, margin.top);
  c.lineTo(canvas.width - margin.right, canvas.height - margin.bottom);
  c.lineTo(margin.left, canvas.height - margin.bottom);
  c.lineTo(margin.left, margin.top);
  c.strokeStyle = style.color;
  c.stroke();
  c.fillStyle = style.color;
  c.font = style.font;
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  // milliseconds
  grid.milliseconds.items.forEach((item, i) => {
    if (item.label)
      vertical_label(item.tm, X(item.tm), canvas.height - margin.bottom + 4);
  });
  // seconds
  grid.seconds.items.forEach((item, i) => {
    if (item.label)
      vertical_label(item.tm, X(item.tm), canvas.height - margin.bottom + 4);
  });
  // minutes
  grid.minutes.items.forEach((item, i) => {
    if (item.label)
      vertical_label(item.tm, X(item.tm), canvas.height - margin.bottom + 4);
  });
  // hours
  grid.hours.items.forEach((item, i) => {
    if (item.label)
      vertical_label(item.tm, X(item.tm), canvas.height - margin.bottom + 4);
  });
  c.textAlign = 'left';
  c.textBaseline = 'bottom';
  // days
  grid.days.items.forEach((item, i) => {
    c.fillText(item.date, item.x, margin.top);
  });
  // months
  grid.months.items.forEach((item, i) => {
    if (labels.day_pixels[labels.day_pixels.length - 1] > (pixels * f.d)) shift = 0;
    else shift = 20;
    c.fillText(item.date, item.x, margin.top - shift);
  });
  // years
  if (labels.day_pixels[labels.day_pixels.length - 1] > (pixels * f.d))
    grid.years.items.forEach((item, i) => {
      c.fillText(item.date, item.x, margin.top - 20);
    });
}

function yAxis() {
  c.fillStyle = style.color;
  c.font = style.font;
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  c.fillText(String(canvas.width), margin.left - 10, margin.top);
  c.fillText(String(canvas.height), margin.left - 10, canvas.height - margin.bottom);
}

function redLine() {
  c.beginPath();
  c.moveTo(X(now), 0);
  c.lineTo(X(now), canvas.height);
  c.strokeStyle = '#ff000088';
  c.stroke();
}

function plotData() {}

follow_view();
