var canvas = document.getElementById('timeseries');
var c = canvas.getContext('2d');
var width = canvas.clientWidth;
var height = canvas.clientHeight;
canvas.width = width;
canvas.height = height;
var style = window.getComputedStyle(canvas);
var BB = canvas.getBoundingClientRect();
var offsetX = BB.left;
var offsetY = BB.top;
var startDragX = 0,
  startTmin, startTmax;
leftMargin = 70;
rightMargin = 50;
topMargin = 50;
bottomMargin = 90;
plotWidth = width - leftMargin - rightMargin;
plotHeight = height - topMargin - bottomMargin;
tmax = Date.now();
tmin = tmax - 86400000;
ymin = 0;
ymax = 1;
zf = 0.1; // the smaller the smoother the wheel zoom

window.onresize = function() {
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  canvas.width = width;
  canvas.height = height;
  plotWidth = width - leftMargin - rightMargin;
  plotHeight = height - topMargin - bottomMargin;
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
  offset = (startDragX - e.clientX) / plotWidth * (tmax - tmin);
  tmin = startTmin + offset;
  tmax = startTmax + offset;
  plotAll();
}

canvas.onmouseup = function(e) {
  startDragX = 0;
}

canvas.onwheel = function(e) {
  r = tmax - tmin;
  lr = (e.clientX - offsetX - leftMargin) / plotWidth;
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

function plotAll() {
  background();
  plotData();
  frame();
  yAxis();
  xAxis();
}

function X(t) {
  return (t - tmin) / (tmax - tmin) * plotWidth + leftMargin;
}

function rT(x) {
  return (x - leftMargin) / plotWidth * (tmax - tmin) + tmin;
}

function Y(y) {
  return (ymax - y) / (ymax - ymin) * plotHeight + topMargin;
}

function rY(Y) {
  return ymax - (Y - topMargin) / plotHeight * (ymax - ymin);
}

function timedensity() {
  return 
}

function rotateText(text, x, y) {
  c.save();
  c.translate(x, y);
  c.rotate(-Math.PI / 2);
  c.fillText(text, 0, 0);
  c.restore();
}

function time(t) {
  return String(t.getHours()) + ':' +
    String(t.getMinutes()).padStart(2, '0');
}

function background() {
  c.fillStyle = 'white';
  c.fillRect(leftMargin, topMargin, plotWidth, plotHeight);
}

function frame() {
  c.fillStyle = style.backgroundColor;
  c.fillRect(0, 0, width, topMargin);
  c.fillRect(0, topMargin, leftMargin, height - topMargin);
  c.fillRect(leftMargin, height - bottomMargin, width - leftMargin, bottomMargin);
  c.fillRect(width - rightMargin, topMargin, rightMargin, plotHeight);
}

function xAxis() {
  c.fillStyle = style.color;
  c.font = style.font;
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  for (var i = Math.floor(tmin / 3600000 + 1) * 3600000; i < tmax; i += 3600000) {
    c.beginPath();
    c.moveTo(X(i), height - bottomMargin);
    c.lineTo(X(i), height - bottomMargin - 4);
    c.fillStyle = style.color;
    c.stroke();
    rotateText(time(new Date(i)), X(i) + 1, height - bottomMargin + 4);
  }
}

function yAxis() {
  c.beginPath();
  c.moveTo(leftMargin, topMargin);
  c.lineTo(width - rightMargin, topMargin);
  c.lineTo(width - rightMargin, height - bottomMargin);
  c.lineTo(leftMargin, height - bottomMargin);
  c.lineTo(leftMargin, topMargin);
  c.strokeStyle = style.color;
  c.stroke();
  c.fillStyle = style.color;
  c.font = style.font;
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  c.fillText(String(width), leftMargin - 10, topMargin);
  c.fillText(String(height), leftMargin - 10, height - bottomMargin);
}

function plotData() {
  for (var i = 0; i < 10000; i++) {
    var farbwert_r = Math.floor(Math.random() * 255);
    var farbwert_g = Math.floor(Math.random() * 255);
    var farbwert_b = Math.floor(Math.random() * 255);
    c.fillStyle = 'rgba(' + farbwert_r + ',' + farbwert_g + ',' + farbwert_b + ', 0.4)';
    c.fillRect(X(Date.now() - 6000000), Y(Math.random()), 10, 10);
  }
}

plotAll();
