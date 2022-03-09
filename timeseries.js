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
margin = {
  top: 50,
  right: 12,
  bottom: 70,
  left: 70
}
plotWidth = canvas.width - margin.left - margin.right;
plotHeight = canvas.height - margin.top - margin.bottom;
tmax = Date.now();
tmin = tmax - 86400000;
ymin = 0;
ymax = 1;
zf = 0.2; // the smaller the smoother the wheel zoom
ss = 5; // the minimal pixel distance for Axis decorations

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

window.onresize = function() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  plotWidth = canvas.width - margin.left - margin.right;
  plotHeight = canvas.height - margin.top - margin.bottom;
  plotAll();
}

canvas.onmousedown = function(e) {
  // is in canvas ...
  startDragX = e.clientX;
  startTmin = tmin;
  startTmax = tmax;
}

canvas.onmousemove = function(e) {
  if (startDragX == 0) return;
  move = (startDragX - e.clientX) / plotWidth * (tmax - tmin);
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
  r = tmax - tmin;
  lr = (e.clientX - offset.x - margin.left) / plotWidth;
  rr = 1 - lr;
  if (e.deltaY > 0) {
    tmin -= zf * lr * r;
    tmax += zf * rr * r;
  } else {
    tmin += zf * lr * r;
    tmax -= zf * rr * r;
  }
  plotAll()
}

function label_day(d, l) {
  if (l > 130) return d.toLocaleString('default', {
    weekday: 'long',
    day: 'numeric',
    month: 'numeric',
  });
  if (l > 60) return d.toLocaleString('default', {
    weekday: 'short',
    day: 'numeric',
  });
  if (l > 24) return d.toLocaleString('default', {
    day: 'numeric',
  }) + '.';
  if (l > 20) return d.toLocaleString('default', {
    day: 'numeric',
  });
  return '';
}

function create_grid() {
  pixels = plotWidth / (tmax - tmin);

  // minutes
  grid.minutes.items = [];
  grid.minutes.space = pixels * f.m;
  if (grid.minutes.space > ss)
    for (t = Math.floor(tmin / f.m) * f.m; t < tmax; t += f.m)
      grid.minutes.items.push({
        tm: t
      });

  // hours
  grid.hours.items = [];
  grid.hours.space = pixels * f.h;
  if (grid.hours.space > ss)
    for (t = Math.floor(tmin / f.h) * f.h; t < tmax; t += f.h)
      grid.hours.items.push({
        tm: t
      });

  // days
  grid.days.items = [];
  space = pixels * f.d;
  if (space > ss)
    for (t = new Date(new Date(tmax).toDateString()); t >= tmin - f.d; t = new Date(new Date(t - 12 * f.h).toDateString())) {
      if (t < tmin) x = margin.left;
      else x = X(t);
      l = grid.days.items.length;
      if (l) len = grid.days.items[l - 1].x - x;
      else len = canvas.width - margin.right - x;
      date = label_day(t, len);
      grid.days.items.push({
        tm: t,
        date: date,
        x: x,
        len: len
      });
    }

  // months
  grid.months.items = [];
  space = pixels * f.d * 31;
  dm = new Date(tmin);
  if (space > ss) {
    while (true) {
      t = Date.parse(dm.getFullYear() + '-' + (dm.getMonth() + 1) + '-1 00:00');
      dm = new Date(t + f.d * 32);
      if (t <= tmax) grid.months.items.push({
        tm: new Date(t)
      });
      else break;
    }
  }
}

function plotAll() {
  create_grid();
  background();
  plotData();
  frame();
  yAxis();
  xAxis();
}

function time(t) {
  return String(t.getHours()) + ':' +
    String(t.getMinutes()).padStart(2, '0');
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
      else c.fillStyle = '#bdd';
    }
    c.fillRect(item.x, margin.top, item.len, plotHeight);
    c.strokeStyle = '#000';
    c.beginPath();
    c.moveTo(item.x, margin.top);
    c.lineTo(item.x, margin.top + plotHeight);
    c.stroke();
  });
  grid.hours.items.forEach((item, i) => {
    x = X(item.tm);
    //c.fillStyle = '#efe';
    //c.fillRect(x, margin.top, 10, plotHeight);
    c.strokeStyle = '#aaa';
    c.beginPath();
    c.moveTo(x, margin.top);
    c.lineTo(x, margin.top + plotHeight);
    c.stroke();
  });
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
  c.textAlign = 'left';
  c.textBaseline = 'bottom';
  c.fillStyle = style.color;
  c.font = style.font;
  //c.fillText(new Date(tmin), margin.left, margin.top);
}

function xAxis() {
  c.fillStyle = style.color;
  c.font = style.font;
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  grid.hours.items.forEach((item, i) => {
    if (i > 0) rotateText(time(new Date(item.tm)), X(item.tm), canvas.height - margin.bottom + 4);
  });
  c.textAlign = 'left';
  c.textBaseline = 'bottom';
  grid.days.items.forEach((item, i) => {
    c.fillText(item.date, item.x, margin.top);
  });
  grid.months.items.forEach((item, i) => {
    if (item.tm > tmin) x = X(item.tm);
    else x = margin.left;
    c.fillText(new Date(item.tm).toLocaleString('default', {
      month: 'long',
      year: 'numeric'
    }), x, margin.top - 20);
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

function plotData() {}

plotAll();