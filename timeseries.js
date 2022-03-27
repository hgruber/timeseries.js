//////////////////////////////////////////////////////
// timeseries.js                                    //
// yet another visualization library for timeseries //
// but this one is different, see the demo          //
//////////////////////////////////////////////////////
// settings                                         //
//////////////////////////////////////////////////////

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
c.font = style.font;
fm = c.measureText('22:00:00');
var font_height = 1.4 * fm.actualBoundingBoxAscent + 4;
var font_width = fm.width;
var margin = {
  top: 3 * font_height,
  right: 1 * font_height,
  bottom: font_width,
  left: 70 // should be dependant on y scale
}

var startDragX = 0,
  startTmin, startTmax;
var nls = 'default';
var plotWidth = canvas.width - margin.left - margin.right;
var plotHeight = canvas.height - margin.top - margin.bottom;
var now = Date.now();
var timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
var follow_timers = 0;
var tmax = now;
var tmin = tmax - 86400000;
var ymin = 0;
var ymax = 1;
var zf = 0.1; // the smaller the smoother the wheel zoom
var ppms = plotWidth / (tmax - tmin); // pixels per millisecond
var mspp = 1. / ppms; // milliseconds per pixels
var ppv = plotHeight / (ymax - ymin); // pixels per value
var vpp = 1. / ppv; // values per pixel

var holidays = {
  '1.1': 'Neujahr',
  '1.5': 'Maifeiertag',
  '-2': 'Karfreitag',
  '+0': 'Ostersonntag',
  '+1': 'Ostermontag',
  '+39': 'Himmelfahrt',
  '+49': 'Pfingstsonntag',
  '+50': 'Pfingstmontag',
  '+60': 'Fronleichnahm',
  '3.10': 'Tag der Einheit',
  '24.12': 'Heilig Abend',
  '25.12': '1. Weihnachtstag',
  '26.12': '2. Weihnachtstag',
  '31.12': 'Sylvester'
};

var f = {
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000,
  mon: 2678400000
}

// grid holds all information about the timeaxis
// 0 - milliseconds, 1 -
var grid = [];

var dvtl = 10; // the minimal pixel distance for vertical time lines
var dtl = 3 * font_height; // the minimal pixel distance for time labels

var part1000 = [1, 5, 10, 50, 100, 500];
var part60 = [1, 5, 15, 30];
var part24 = [1, 2, 4, 12];
var part10 = [1, 2, 5];

var animation = {}

//
// create possible labels to create array with maximum length
// stored in labels.day_pixels
// this can vary with font-size as well as with language settings
//
var labels = {}

// month in top row, day in second row: 0
// year in top row, month in second row: 1
// decade in top row, year in second row: 2 (not used..)
// century in top row, decade in second row: 3 (not used..)
var label_level = 0;
var grid_level_label = [
  [5, 6, 7],
  [4, 5, 6]
];
var zoom_onclick_time = 500;

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
  month: 'long'
}, {
  month: 'short'
}, {
  month: 'narrow'
}]

labels.year = [{
  year: 'numeric'
}, {
  year: '2-digit'
}]

////////////////////////////////////
// helper functions and variables //
////////////////////////////////////

// calculate the width of labels
holiday_pixels = {};
for (const [key, holiday] of Object.entries(holidays)) {
  holiday_pixels[holiday] = c.measureText(holiday).width;
};

labels.day_pixels = new Array(labels.day.length).fill(0);
for (var i = 0; i < 7; i++) {
  labels.day.forEach((format, j) => {
    l = c.measureText(new Date((i + 355) * f.d).toLocaleString(nls, format)).width;
    if (l > labels.day_pixels[j]) labels.day_pixels[j] = l;
  });
}

labels.month_pixels = new Array(labels.month.length).fill(0);
for (var i = 0; i < 12; i++) {
  labels.month.forEach((format, j) => {
    l = c.measureText(new Date((i * 30 + 5) * f.d).toLocaleString(nls, format)).width;
    if (l > labels.month_pixels[j]) labels.month_pixels[j] = l;
  });
}

labels.year_pixels = [c.measureText('2000').width, c.measureText('20').width]

function Easter(Y) {
  var C = Math.floor(Y / 100);
  var N = Y - 19 * Math.floor(Y / 19);
  var K = Math.floor((C - 17) / 25);
  var I = C - Math.floor(C / 4) - Math.floor((C - K) / 3) + 19 * N + 15;
  I = I - 30 * Math.floor((I / 30));
  I = I - Math.floor(I / 28) * (1 - Math.floor(I / 28) * Math.floor(29 / (I + 1)) * Math.floor((21 - N) / 11));
  var J = Y + Math.floor(Y / 4) + I + 2 - C + Math.floor(C / 4);
  J = J - 7 * Math.floor(J / 7);
  var L = I - J;
  var M = 3 + Math.floor((L + 40) / 44);
  var D = L + 28 - 31 * Math.floor(M / 4);
  return D + '.' + M;
}

Date.prototype.getWeek = function() {
  //https://stackoverflow.com/questions/6117814/get-week-of-year-in-javascript-like-in-php
  var d = new Date(Date.UTC(this.getFullYear(), this.getMonth(), this.getDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

var easterYears = {}; // store dates for every year
var hL = {}; // store all holidays here

function isHoliday(date) {
  var Y = date.getFullYear();
  var d = date.getDate() + '.' + (date.getMonth() + 1);
  var di = d + '.' + Y;
  if (hL.hasOwnProperty(di)) return hL[di];
  var EasterDate;
  if (!easterYears.hasOwnProperty(Y.toString())) {
    easterYears[Y] = Easter(Y);
  }
  var a = easterYears[Y].split('.');
  for (var day in holidays) {
    if (d == day) {
      hL[di] = holidays[day];
      return holidays[day];
    } else if (day[0] == '-' || day[0] == '+') {
      var checkDay = new Date(Y, a[1] - 1, a[0]);
      checkDay.setDate(checkDay.getDate() + Number(day));
      checkDay = checkDay.getDate() + '.' + (checkDay.getMonth() + 1);
      if (d == checkDay) {
        hL[di] = holidays[day];
        return holidays[day];
      }
    }
  }
  hL[di] = false;
  return false;
}

// needed for timeSeries
// a and b are arrays of intervals: [ [min_1,max_1], [min_2,max_2], .., [min_n,max_n] ]
// the difference function returns the difference a-b which again is an array of intervals
//     if a is your viewport (the data you want to display) and b your cache map
//     then you have to iterate through the result array and fetch data for every interval
// the add method returns the sum a + b which again is an array of intervals
// the intersect function returns the intersection of a and b which is an array of intervals
// the iLength function returns the sum (scalar) of a's interval length
// the invert function returns the inverse interval
//
// unit tests for a.substract(b), a.intersect(b) and a.add(b)
/*
console.log('Result: ' + [[1,3],[8,10],[17,20]].add( [[2,11], [14,15]] ) );
console.log('Result: ' + [[1,3],[8,10],[17,20]].substract( [[2,11], [14,15]] ) );
console.log('Result: ' + [[1,3],[8,10],[17,20]].intersect( [[2,11], [14,15]] ) );
console.log('Result: ' + [[Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]].substract([[2,11], [14,15]] ));
console.log('Result: ' + [].add( [[2,11], [14,15]] ) );
console.log('Result: ' + [].substract( [[2,11], [14,15]] ) );
console.log('Result: ' + [[1,3],[8,10],[17,20]].iLength());
console.log('Result: ' + [[Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]].iLength();
*/
// "Result: 1,11,14,15,17,20"
// "Result: 1,2,17,20"
// "Result: 2,3,8,10"
// "Result: -Infinity,2,11,14,15,Infinity"
// "Result: 2,11,14,15"
// "Result: "
// "Result: 7"
// "Result: Infinity"

Array.prototype.substract = function(b) {
  function difference(m, s) {
    if (s[1] <= m[0] || m[1] <= s[0]) return [m];
    if (s[1] < m[1]) {
      if (s[0] <= m[0]) return [
        [s[1], m[1]]
      ];
      return [
        [m[0], s[0]],
        [s[1], m[1]]
      ];
    }
    if (s[0] <= m[0]) return [];
    return [
      [m[0], s[0]]
    ];
  }

  function single(m, s) {
    diff = [];
    m.forEach(function(md) {
      difference(md, s).forEach(function(ret) {
        diff.push(ret);
      });
    });
    return diff;
  }
  if (this === undefined || b === undefined) return [];
  var diff = this;
  b.forEach(function(m) {
    diff = single(diff, m);
  });
  return diff;
}

Array.prototype.invert = function() {
  return [
    [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
  ].substract(this);
}

Array.prototype.intersect = function(b) {
  if (this === undefined || b === undefined) return [];
  return this.substract(b.invert());
}

Array.prototype.add = function(b) {
  function sum(m, s) {
    if (s[1] < m[0]) return [s, m];
    if (m[1] < s[0]) return [m, s];
    if (s[1] < m[1]) {
      if (s[0] <= m[0]) return [
        [s[0], m[1]]
      ];
      return [m];
    }
    if (s[0] <= m[0]) return [s];
    return [
      [m[0], s[1]]
    ];
  }
  if (this === undefined || b === undefined) return [];
  var dummy = this.concat(b).sort(function(a, b) {
    return a[0] - b[0];
  });
  var result = dummy.slice();
  for (i = 1; i < dummy.length; i++) {
    var s = sum(dummy[i - 1], dummy[i]);
    if (s.length == 1) {
      result.splice(0, 1);
      result[0] = s[0];
      dummy[i] = s[0];
    }
  }
  return result;
}

Array.prototype.iLength = function() {
  var length = 0;
  this.forEach(function(o) {
    length = length + Number(o[1]) - Number(o[0]);
  });
  return length;
}

//////////////////////////
// timeseries functions //
//////////////////////////

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

function zoom(target_tmin, target_tmax, time) {
  if (tmin == target_tmin && tmax == target_tmax)
    return;
  animation.startT = +Date.now() - 20;
  animation.endT = animation.startT + time;
  animation.start = {
    tmin: tmin,
    tmax: tmax
  }
  animation.end = {
    tmin: target_tmin,
    tmax: target_tmax
  }
  animate();
}

function animate() {
  function easeInOutExpo(x) {
    return x === 0 ? 0 :
      x === 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 :
      (2 - Math.pow(2, -20 * x + 10)) / 2;
  }
  now = Date.now();
  done = false;
  if (now > animation.endT) {
    now = animation.endT;
    done = true;
  }
  t = easeInOutExpo((now - animation.startT) / (animation.endT - animation.startT));
  for (const [key, value] of Object.entries(animation.start))
    window[key] = animation.start[key] * (1 - t) + animation.end[key] * t;
  if (!done) setTimeout(animate, 10);
  plotAll();
}

function plotAll() {
  c.clearRect(0, 0, canvas.width, canvas.height);
  prepare_grid();
  background();
  plotData();
  frame();
  yAxis();
  redLine();
  // console.log('plot finished: ' + follow_timers);
  // console.log(grid);
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
  var item = mouse_position(e);
  x = e.clientX - offset.x;
  y = e.clientY - offset.y;
  var browse = 'no';
  if (item.browse) {
    if (x - margin.left < font_height) browse = 'left';
    if (x > plotWidth + margin.left - font_height) browse = 'right';
  }
  if (item.level == 4) {
    if (browse == 'no')
      zoom(+item.tm, +(new Date(new Date(+item.tm + f.d + 2 * f.h).toDateString())), zoom_onclick_time);
    else if (browse == 'left')
      zoom(+(new Date(new Date(+item.tm - 2 * f.h).toDateString())), +item.tm, zoom_onclick_time);
    else
      zoom(+(new Date(new Date(+item.tm + f.d + 2 * f.h).toDateString())), +(new Date(new Date(+item.tm + 2 * f.d + 2 * f.h).toDateString())), zoom_onclick_time);
    return;
  }
  if (item.level == 5) {
    if (browse == 'no') {
      var dm = new Date(+item.tm + f.mon + 2 * f.d);
      zoom(+item.tm, +(new Date(Date.parse(dm.getFullYear() + '-' + (dm.getMonth() + 1) + '-1 00:00'))), zoom_onclick_time);
    } else if (browse == 'left') {
      var dm = new Date(+item.tm + - 2 * f.d);
      zoom(+(new Date(Date.parse(dm.getFullYear() + '-' + (dm.getMonth() + 1) + '-1 00:00'))), +item.tm, zoom_onclick_time);
    } else {
      var dm = new Date(+item.tm + f.mon + 2 * f.d);
      var dm2 = new Date(+dm + f.mon + 2 * f.d);
      zoom(+(new Date(Date.parse(dm.getFullYear() + '-' + (dm.getMonth() + 1) + '-1 00:00'))), +(new Date(Date.parse(dm2.getFullYear() + '-' + (dm2.getMonth() + 1) + '-1 00:00'))), zoom_onclick_time);
    }
    return;
  }
  if (item.level == 6) {
    if (browse == 'no') {
      zoom(+item.tm, +(new Date(Date.parse((item.tm.getFullYear() + 1) + '-1-1 00:00'))), zoom_onclick_time);
    } else if (browse == 'left') {
      zoom(+(new Date(Date.parse((item.tm.getFullYear() - 1) + '-1-1 00:00'))), +item.tm, zoom_onclick_time);
    } else {
      zoom(+(new Date(Date.parse((item.tm.getFullYear() +1 ) + '-1-1 00:00'))), +(new Date(Date.parse((item.tm.getFullYear() + 2) + '-1-1 00:00'))), zoom_onclick_time);
    }
    return;
  }
  startDragX = e.clientX;
  startTmin = tmin;
  startTmax = tmax;
}

canvas.onmousemove = function(e) {
  if (startDragX == 0) {
    return;
  }
  var move = (startDragX - e.clientX) / plotWidth * (tmax - tmin);
  tmin = startTmin + move;
  tmax = startTmax + move;
  plotAll();
}

canvas.onmouseup = function(e) {
  startDragX = 0;
}

canvas.onmouseout = function(e) {
  startDragX = 0;
}

canvas.onwheel = function(e) {
  if (ppms > 25 && e.deltaY < 0) return;
  if (ppms < 6e-9 && e.deltaY > 0) return;
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
    if (ppms * t * p[pp] > d) return p[pp];
}

function mouse_position(e) {
  var x = e.clientX - offset.x;
  var y = e.clientY - offset.y;
  if (margin.left < x && x < plotWidth + margin.left) {
    if (margin.top < y && y < plotHeight + margin.top) {
      // plot area
      return 'plotarea';
    } else if (margin.top - 2 * font_height < y && y < margin.top - font_height) {
      // first label row
      item = get_grid(x, grid_level_label[0][label_level]);
      item.y = margin.top - font_height;
      return item;
    }
    if (margin.top - font_height < y && y < margin.top) {
      // second label row
      item = get_grid(x, grid_level_label[1][label_level]);
      item.y = margin.top;
      return item;
    }
  }
  // frame
  return 'frame';
}

// return grid element of given canvas coordinates
function get_grid(x, grid_level) {
  for (var j = 0; j < grid[grid_level].length; j++) {
    item = grid[grid_level][j];
    if (item.x < x && x < item.x + item.len) {
      item.level = grid_level;
      return item;
    }
  }
}

function prepare_grid() {
  ppms = plotWidth / (tmax - tmin);
  mspp = 1. / ppms;
  dtm = new Date(tmax);

  // milliseconds
  var part = time_part(part1000, 1, dvtl);
  var partl = time_part(part1000, 1, dtl);
  grid[0] = [];
  if (part)
    for (var t = Math.floor(tmin); t < Math.ceil(tmax); t++) {
      if (t % part == 0) {
        var d = new Date(t);
        grid[0].push({
          tm: d,
          label: ((t % partl == 0 && t % 1000 > 0) ? ':' + String(d.getSeconds()).padStart(2, '0') + '.' + String(d.getMilliseconds()).padStart(3, '0') : false),
          x: X(t),
          len: part * ppms,
          fill: ((part == 1) ? ((t % 2) ? 'rgba(240,240,240,0.5)' : 'rgba(196,196,196,0.5)') : false)
        });
      }
    }

  // seconds
  part = time_part(part60, f.s, dvtl);
  partl = time_part(part60, f.s, dtl);
  grid[1] = [];
  if (part)
    for (var t = Math.floor(tmin / f.s) * f.s; t < tmax; t += f.s) {
      var d = new Date(t);
      s = d / 1000;
      if (s % part == 0) grid[1].push({
        tm: d,
        label: (s % partl == 0),
        x: X(t),
        len: part * ppms * f.s,
        fill: ((part == 1) ? ((s % 2) ? 'rgba(255,255,240,0.5)' : 'rgba(255,255,196,0.5)') : false)
      });
    }

  // minutes
  part = time_part(part60, f.m, dvtl);
  partl = time_part(part60, f.m, dtl);
  grid[2] = [];
  if (part)
    for (var t = Math.floor(tmin / f.m) * f.m; t < tmax; t += f.m) {
      var d = new Date(t);
      var m = d.getMinutes();
      if (m % part == 0) grid[2].push({
        tm: d,
        label: (m % partl == 0),
        x: X(t),
        len: part * ppms * f.m,
        fill: ((part == 1) ? ((m % 2) ? 'rgba(240,255,240,0.5)' : 'rgba(196,255,196,0.5)') : false)
      });
    }

  // hours
  grid[3] = [];
  part = time_part(part24, f.h, dvtl);
  partl = time_part(part24, f.h, dtl);
  var ds = f.h * part;
  if (part)
    for (var t = Math.floor(tmin / f.h) * f.h; t < tmax; t += f.h) {
      var d = new Date(t);
      var h = d.getHours();
      if (h % part == 0) grid[3].push({
        tm: d,
        label: (h % partl == 0),
        x: X(t),
        len: part * ppms * f.h,
        fill: ((part == 1) ? ((h % 2) ? 'rgba(240,240,255,0.5)' : 'rgba(196,196,255,0.5)') : false)
      });
    }

  // days
  grid[4] = [];
  space = ppms * f.d;
  if (space > dvtl)
    for (var t = new Date(new Date(tmax).toDateString()); t >= tmin - f.d; t = new Date(new Date(t - 12 * f.h).toDateString())) {
      if (t < tmin) x = margin.left;
      else x = X(t);
      l = grid[4].length;
      if (l) len = grid[4][l - 1].x - x;
      else len = canvas.width - margin.right - x;
      var h = isHoliday(t);
      var bh = (h != false);
      if (h) {
        if (holiday_pixels[h] > len) h = label(t, 'day', len);
        else h = (label(t, 'day', len - holiday_pixels[h] - 5) + ' ' + h).trim();
      }
      wd = t.getDay();
      var fill = 'rgba(196,196,196,0.5)';
      if (wd == 0 || wd == 6 || bh) fill = 'rgba(255,166,166,0.5)';
      else if (wd % 2) fill = 'rgba(224,224,224,0.5)';
      grid[4].push({
        tm: t,
        label: ((h) ? h : label(t, 'day', len)),
        x: x,
        len: len,
        fill: fill,
        cw: ((wd == 1) ? t.getWeek() : ''),
        browse: ( t <= tmin && len + x >= canvas.width - margin.right)
      });
    }

  // months
  grid[5] = [];
  space = ppms * f.d * 31;
  var dm = dtm;
  if (space > dvtl) {
    while (true) {
      t = new Date(Date.parse(dm.getFullYear() + '-' + (dm.getMonth() + 1) + '-1 00:00'));
      if (t < tmin) x = margin.left;
      else x = X(t);
      l = grid[5].length;
      if (l) len = grid[5][l - 1].x - x;
      else len = canvas.width - margin.right - x;
      grid[5].push({
        tm: t,
        label: label(t, 'month', len),
        x: x,
        len: len,
        fill: ((t.getMonth() % 2) ? 'rgba(85,148,200,0.5)' : 'rgba(240,240,240,0.5)'),
        browse: ( t <= tmin && len +x >= canvas.width - margin.right)
      });
      dm = new Date(t - 1);
      if (dm < tmin) break;
    }
  }

  // years
  dm = dtm;
  grid[6] = [];
  space = ppms * f.d * 365;
  if (space > dvtl) {
    for (t = new Date(Date.parse(dm.getFullYear() + '-1-1 00:00')); t >= tmin - 366 * f.d; t = new Date(Date.parse(new Date(t - 70 * f.d).getFullYear() + '-1-1 00:00'))) {
      if (t < tmin) x = margin.left;
      else x = X(t);
      l = grid[6].length;
      if (l) len = grid[6][l - 1].x - x;
      else len = canvas.width - margin.right - x;
      grid[6].push({
        tm: t,
        label: label(t, 'year', len),
        x: x,
        len: len,
        fill: ((t.getFullYear() % 2) ? 'rgba(255,255,255,0.4)' : 'rgba(240,240,240,0.4)'),
        browse: ( t <= tmin && len +x >= canvas.width - margin.right)
      });
    }
  }

  if (labels.day_pixels[labels.day_pixels.length - 1] > (ppms * f.d)) {
    // year in top row, month in second row
    label_level = 1;
  } else {
    // month in top row, day in second row
    label_level = 0;
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

function horizontal_label(item, position) {
  c.textAlign = 'center';
  c.textBaseline = 'bottom';
  c.fillStyle = item.fill;
  c.fillRect(item.x, position - font_height, item.len, font_height);
  c.fillStyle = style.color;
  c.fillText(item.label, item.x + item.len / 2, position - 1);
  if (item.browse) {
    c.textAlign = 'left';
    c.fillText('«', margin.left + 4, position -1);
    c.textAlign = 'right';
    c.fillText('»', canvas.width - margin.right - 4, position - 1);
  }
  c.beginPath();
  c.moveTo(item.x, position);
  c.lineTo(item.x, position - font_height);
  c.lineTo(item.x + item.len, position - font_height);
  c.stroke();
}

function vertical_line(t, color) {
  var x = X(+t);
  c.strokeStyle = color;
  c.beginPath();
  c.moveTo(x, margin.top);
  c.lineTo(x, margin.top + plotHeight);
  c.stroke();
}

function background() {
  c.fillStyle = 'white';
  c.fillRect(margin.left, margin.top, plotWidth, plotHeight);
  Object.keys(grid).reverse().forEach(function(layer) {
    grid[layer].forEach(function(item) {
      if (item.fill) {
        c.fillStyle = item.fill;
        c.fillRect(item.x, margin.top, item.len, plotHeight);
      }
      vertical_line(item.tm, 'grey');
      if (item.cw) {
        c.textAlign = 'left';
        x = X(item.tm);
        if (x < margin.left) x = margin.left;
        c.fillStyle = '#888';
        c.textAlign = 'left';
        c.textBaseline = 'bottom';
        c.fillText(item.cw, x + 1, canvas.height - margin.bottom);
      }
    });
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
  c.moveTo(canvas.width - margin.right, margin.top);
  c.lineTo(canvas.width - margin.right, margin.top - 2 * font_height);
  c.strokeStyle = style.color;
  c.stroke();
  c.fillStyle = style.color;
  c.font = style.font;
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  for (var level = 0; level < 4; level++)
    grid[level].forEach((item, i) => {
      if (item.label)
        vertical_label(item.tm, X(item.tm), canvas.height - margin.bottom + 4);
    });
  // days
  grid[4].forEach((item, i) => {
    horizontal_label(item, margin.top);
  });
  // months
  grid[5].forEach((item, i) => {
    horizontal_label(item, margin.top - (1 - label_level) * font_height);
  });
  // years
  if (label_level > 0)
    grid[6].forEach((item, i) => {
      horizontal_label(item, margin.top - font_height);
    });
}

function yAxis() {
  c.fillStyle = style.color;
  c.font = style.font;
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  c.fillText(String(ymax), margin.left - 10, margin.top);
  c.fillText(String(ymin), margin.left - 10, canvas.height - margin.bottom);
}

function redLine() {
  c.beginPath();
  c.moveTo(X(now), 0);
  c.lineTo(X(now), canvas.height - margin.bottom);
  c.strokeStyle = 'rgba(255,0,0,0.5)';
  c.stroke();
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.font = '0.65em Arial';
  c.fillStyle = 'rgba(255,0,0, 0.5)'
  rotateText(timezone, X(now), canvas.height);
  c.font = style.font;
  c.fillStyle = 'black';
}

function fog_of_future() {
  if (now >= tmax) return;
  if (now < tmin) x = margin.left;
  else x = X(now);
  c.fillStyle = 'rgba(160,160,160, 0.4)';
  c.fillRect(x, margin.top, plotWidth, plotHeight);
}

function multibar(plot) {
  for (const [t, bars] of Object.entries(plot.data)) {
    var height = 0;
    for (const [i, bar] of Object.entries(bars)) {
      var farbwert_r = (((i + 111) % 67) * 798) % 255;
      var farbwert_g = (((i + 53) % 23) * 1131) % 255;
      var farbwert_b = (((i + 79) % 19) * 979) % 255;;
      c.fillStyle = 'rgb(' + farbwert_r + ',' + farbwert_g + ',' + farbwert_b + ', 0.8)';
      c.fillRect(X(interval[0] + t * plot.interval * 1000),
        Y(height),
        ppms * plot.interval * 1000,
        -ppv * bar);
      height += bar;
    }
  }
}

function plotData() {
  data.forEach((plot, i) => {
    plot.interval_end = plot.interval_start + plot.interval * plot.count;
    interval = [plot.interval_start * 1000, plot.interval_end * 1000];
    if ([[tmin,tmax]].intersect([interval]).length) {
      // y Axis needs proper handling
      ymin = 0;
      ymax = plot.max;
      ppv = plotHeight / (ymax - ymin);
      vpp = 1. / ppv;
      if (plot.type == 'multibar') multibar(plot);
    }
  });
}

follow_view();
