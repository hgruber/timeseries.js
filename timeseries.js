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
var ss = 2; // the minimal pixel distance for Axis decorations
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

var display_hours = [{
  p: 2,
  c: 1
}, {
  p: 1.5,
  c: 2
}, {
  p: 1,
  c: 4
}, {}, {
  p: 0.75,
  c: 6
}, {
  p: 0.5,
  c: 12
}]; // text width p in pixels displays onl every c's hour

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
  month: 'short'
}]

c.font = style.font;
var font_height = c.measureText('2').actualBoundingBoxAscent;

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
  var r = grid.hours.space / font_height;
  for (let dd in display_hours) {
    if (r > display_hours[dd].p) {
      text = String(t.getHours()) + ':' + String(t.getMinutes()).padStart(2, '0');
      if (t%f.m > 0) text += ':' + String(t.getSeconds()).padStart(2, '0');
      if (t.getHours() % display_hours[dd].c == 0) rotateText(text, x, y);
      return;
    }
  }
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
    t = mspp;
    if (mspp > 5000) t = 5000;
    timer(follow_view, t);
    plotAll();
    return;
  }
  if (now < tmax && tmin < now) {
    t = tmax - now;
    if (t > 1000) t = 1000;
    timer(follow_view, t);
    plotAll();
    return
  }
}

function plotAll() {
  prepare_grid();
  background();
  plotData();
  frame();
  yAxis();
  redLine();
  //console.log('plot finished: ' + follow_timers);
  //console.log(grid);
  if (follow_timers<0) timer(follow_view, 1000);
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

function prepare_grid() {
  pixels = plotWidth / (tmax - tmin); // pixels per millisecond
  mspp = 1. / pixels; // milliseconds per pixels

  // seconds
  grid.seconds.items = [];
  grid.seconds.space = pixels * f.s;
  if (grid.seconds.space > ss)
    for (var t = Math.floor(tmin / f.s) * f.s; t < tmax; t += f.s)
      grid.seconds.items.push({
        tm: new Date(t)
      });

  // minutes
  grid.minutes.items = [];
  grid.minutes.space = pixels * f.m;
  if (grid.minutes.space > ss)
    for (var t = Math.floor(tmin / f.m) * f.m; t < tmax; t += f.m)
      grid.minutes.items.push({
        tm: new Date(t)
      });

  // hours
  grid.hours.items = [];
  grid.hours.space = pixels * f.h;
  if (grid.hours.space > ss)
    for (var t = Math.floor(tmin / f.h) * f.h; t < tmax; t += f.h)
      grid.hours.items.push({
        tm: new Date(t)
      });

  // days
  grid.days.items = [];
  space = pixels * f.d;
  if (space > ss)
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
  dm = new Date(tmax);
  if (space > ss) {
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
  grid.days.items.forEach((item, i) => {
    wd = item.tm.getDay();
    if (wd == 0 || wd == 6) c.fillStyle = '#fbb';
    else {
      if (wd % 2) c.fillStyle = '#eee';
      else c.fillStyle = '#ddd';
    }
    c.fillRect(item.x, margin.top, item.len, plotHeight);
    c.strokeStyle = '#888';
    c.beginPath();
    c.moveTo(item.x, margin.top);
    c.lineTo(item.x, margin.top + plotHeight);
    c.stroke();
  });
  grid.hours.items.forEach((item, i) => {
    x = X(item.tm);
    c.strokeStyle = '#aaa';
    c.beginPath();
    c.moveTo(x, margin.top);
    c.lineTo(x, margin.top + plotHeight);
    c.stroke();
  });
  grid.minutes.items.forEach((item, i) => {
    x = X(item.tm);
    c.strokeStyle = '#aaa';
    c.beginPath();
    c.moveTo(x, margin.top);
    c.lineTo(x, margin.top + plotHeight);
    c.stroke();
  });
  grid.seconds.items.forEach((item, i) => {
    x = X(item.tm);
    c.strokeStyle = '#aaa';
    c.beginPath();
    c.moveTo(x, margin.top);
    c.lineTo(x, margin.top + plotHeight);
    c.stroke();
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
  // seconds
  grid.seconds.items.forEach((item, i) => {
    if (i == 0) return;
    vertical_label(item.tm, X(item.tm), canvas.height - margin.bottom + 4);
  });
  // minutes
  grid.minutes.items.forEach((item, i) => {
    if (i == 0) return;
    vertical_label(item.tm, X(item.tm), canvas.height - margin.bottom + 4);
  });
  // hours
  grid.hours.items.forEach((item, i) => {
    if (i == 0) return;
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
