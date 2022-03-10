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
nls = 'default';
plotWidth = canvas.width - margin.left - margin.right;
plotHeight = canvas.height - margin.top - margin.bottom;
var now = Date.now();
tmax = now;
tmin = tmax - 86400000;
ymin = 0;
ymax = 1;
zf = 0.2; // the smaller the smoother the wheel zoom
ss = 5; // the minimal pixel distance for Axis decorations
pixels = plotWidth / (tmax - tmin); // pixels per millisecond
mspp = 1. / pixels; // milliseconds per pixels

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

display_hours = [{
  p: 40,
  c: 1
}, {
  p: 20,
  c: 2
}, {
  p: 13,
  c: 3
}, {
}, {
  p: 7,
  c: 6
}, {
  p: 3,
  c: 12
}]; // text width p in pixels displays onl every c's hour

function plotAll() {
  prepare_grid();
  background();
  plotData();
  frame();
  yAxis();
  redLine();
  console.log('plot finished');
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

function follow_view() {
  now = Date.now();
  if (tmax - mspp < now && now < tmax + 10 * mspp) {
    tmin = tmin + now - tmax;
    tmax = now;
    plotAll();
    setTimeout(follow_view, mspp);
    return;
  }
  if (now < tmax) t = tmax - now;
  else return;
  if (t > 1000) t = 1000;
  setTimeout(follow_view, t);
}

function label_day(d, l) {
  if (l > 130) return d.toLocaleString(nls, {
    weekday: 'long',
    day: 'numeric',
    month: 'numeric',
  });
  if (l > 60) return d.toLocaleString(nls, {
    weekday: 'short',
    day: 'numeric',
  });
  if (l>14) return d.toLocaleString(nls, {
    day: 'numeric',
  });
  return '';
}

function label_month(d,l) {
  if (l > 130) return d.toLocaleString(nls, {
    month: 'long',
    year: 'numeric'
  });
  if (l > 105) return d.toLocaleString(nls, {
    month: 'long',
    year: '2-digit'
  });
  if (l > 65) return d.toLocaleString(nls, {
    month: 'short',
    year: '2-digit'
  });
  if (l > 40) return d.toLocaleString(nls, {
    month: 'short'
  });
  if (l>14) return d.toLocaleString(nls, {
    month: 'short'
  }).substr(0,1);
  return '';
}

function prepare_grid() {
  pixels = plotWidth / (tmax - tmin); // pixels per millisecond
  mspp = 1. / pixels; // milliseconds per pixels

  // minutes
  grid.minutes.items = [];
  grid.minutes.space = pixels * f.m;
  if (grid.minutes.space > ss)
    for (t = Math.floor(tmin / f.m) * f.m; t < tmax; t += f.m)
      grid.minutes.items.push({
        tm: new Date(t)
      });

  // hours
  grid.hours.items = [];
  grid.hours.space = pixels * f.h;
  if (grid.hours.space > ss)
    for (t = Math.floor(tmin / f.h) * f.h; t < tmax; t += f.h)
      grid.hours.items.push({
        tm: new Date(t)
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
      grid.days.items.push({
        tm: t,
        date: label_day(t, len),
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
        date: label_month(t, len),
        x: x,
        len: len
      });
      dm = new Date(t - 1);
      if (dm < tmin) break;
    }
  }
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
  // hours
  grid.hours.items.forEach((item, i) => {
    if (i == 0) return;
    t = new Date(item.tm)
    for (let dd in display_hours) {
      if (grid.hours.space > display_hours[dd].p) {
        if (t.getHours() % display_hours[dd].c == 0) rotateText(time(t), X(item.tm), canvas.height - margin.bottom + 4);
        return;
      }
    }
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
