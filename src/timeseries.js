//////////////////////////////////////////////////////
// timeseries.js                                    //
// yet another visualization library for timeseries //
// but this one is different, see the demo          //
//////////////////////////////////////////////////////
// settings                                         //
//////////////////////////////////////////////////////
import { intervalSubtract, intervalInvert, intervalIntersect, intervalAdd, intervalLength, getWeek } from './intervals.js';
import { plotData as _plotData, highlight as _highlight, registerRenderer } from './renderers.js';
import { initSources, registerSource } from './sources.js';

export default function TimeSeries(options) {
  var settings = {
    canvas: "timeseries",
    timezone: "Europe/Berlin",
    follow: true,
    sources: [], // array of data sources
    holidays: {
      1.1: "Neujahr",
      1.5: "Maifeiertag",
      "-2": "Karfreitag",
      "+0": "Ostersonntag",
      "+1": "Ostermontag",
      "+39": "Himmelfahrt",
      "+49": "Pfingstsonntag",
      "+50": "Pfingstmontag",
      "+60": "Fronleichnahm",
      "3.10": "Tag der Einheit",
      24.12: "Heilig Abend",
      25.12: "1. Weihnachtstag",
      26.12: "2. Weihnachtstag",
      31.12: "Sylvester",
    },
  };
  if (options) {
    for (const [key, value] of Object.entries(options)) {
      settings[key] = value;
    }
  }
  var canvas = document.getElementById(settings.canvas);
  var c = canvas.getContext("2d");
  var timezone = settings.timezone;
  var follow = settings.follow;
  var holidays = settings.holidays;

  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  var BB = canvas.getBoundingClientRect();
  var offset = {
    x: BB.left,
    y: BB.top,
  };
  var style = window.getComputedStyle(canvas);
  c.font = style.font;
  var fm = c.measureText("22:00:00");
  var font_height = 1.4 * fm.actualBoundingBoxAscent + 4;
  var font_width = fm.width;
  var margin = {
    top: 3 * font_height,
    right: 1 * font_height,
    bottom: font_width,
    left: 70, // should be dependant on y scale
  };

  var startDragX = 0,
    startTmin,
    startTmax;
  var nls = "default";
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
  var mspp = 1 / ppms; // milliseconds per pixels
  var ppv = plotHeight / (ymax - ymin); // pixels per value
  var vpp = 1 / ppv; // values per pixel
  var data = [];
  var activePlot;
  var rctx = null; // render context, updated on each plotAll() call

  var f = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    mon: 2678400000,
  };

  // grid holds all information about the timeaxis
  // 0 - milliseconds, 1 -
  var grid = [];
  var ygrid = [];

  var dvtl = 10; // the minimal pixel distance for vertical time lines
  var dtl = 3 * font_height; // the minimal pixel distance for time labels

  var part1000 = [1, 5, 10, 50, 100, 500];
  var part60 = [1, 5, 15, 30];
  var part24 = [1, 2, 4, 12];
  var part10 = [1, 2, 5];

  var animation = {};

  //
  // create possible labels to create array with maximum length
  // stored in labels.day_pixels
  // this can vary with font-size as well as with language settings
  //
  var labels = {};

  // month in top row, day in second row: 0
  // year in top row, month in second row: 1
  // decade in top row, year in second row: 2 (not used..)
  // century in top row, decade in second row: 3 (not used..)
  var label_level = 0;
  var grid_level_label = [
    [5, 6, 7],
    [4, 5, 6],
  ];
  var zoom_onclick_time = 500;

  labels.day = [
    {
      weekday: "long",
      day: "numeric",
      month: "numeric",
    },
    {
      weekday: "short",
      day: "numeric",
    },
    {
      day: "numeric",
    },
  ];

  labels.month = [
    {
      month: "long",
      year: "numeric",
    },
    {
      month: "long",
      year: "2-digit",
    },
    {
      month: "long",
    },
    {
      month: "short",
    },
    {
      month: "narrow",
    },
  ];

  labels.year = [
    {
      year: "numeric",
    },
    {
      year: "2-digit",
    },
  ];

  var onClickData = function (plot, n, item) {
    _highlight(plot, n, item, rctx);
  };

  ////////////////////////////////////
  // helper functions and variables //
  ////////////////////////////////////

  // calculate the width of labels
  var holiday_pixels = {};
  for (const [key, holiday] of Object.entries(holidays)) {
    holiday_pixels[holiday] = c.measureText(holiday).width;
  }

  labels.day_pixels = new Array(labels.day.length).fill(0);
  for (var i = 0; i < 7; i++) {
    labels.day.forEach((format, j) => {
      var l = c.measureText(
        new Date((i + 355) * f.d).toLocaleString(nls, format),
      ).width;
      if (l > labels.day_pixels[j]) labels.day_pixels[j] = l;
    });
  }

  labels.month_pixels = new Array(labels.month.length).fill(0);
  for (var i = 0; i < 12; i++) {
    labels.month.forEach((format, j) => {
      var l = c.measureText(
        new Date((i * 30 + 5) * f.d).toLocaleString(nls, format),
      ).width;
      if (l > labels.month_pixels[j]) labels.month_pixels[j] = l;
    });
  }

  labels.year_pixels = [c.measureText("2000").width, c.measureText("20").width];

  function Easter(Y) {
    var C = Math.floor(Y / 100);
    var N = Y - 19 * Math.floor(Y / 19);
    var K = Math.floor((C - 17) / 25);
    var I = C - Math.floor(C / 4) - Math.floor((C - K) / 3) + 19 * N + 15;
    I = I - 30 * Math.floor(I / 30);
    I =
      I -
      Math.floor(I / 28) *
        (1 -
          Math.floor(I / 28) *
            Math.floor(29 / (I + 1)) *
            Math.floor((21 - N) / 11));
    var J = Y + Math.floor(Y / 4) + I + 2 - C + Math.floor(C / 4);
    J = J - 7 * Math.floor(J / 7);
    var L = I - J;
    var M = 3 + Math.floor((L + 40) / 44);
    var D = L + 28 - 31 * Math.floor(M / 4);
    return D + "." + M;
  }

  var easterYears = {}; // store dates for every year
  var hL = {}; // store all holidays here

  function isHoliday(date) {
    var Y = date.getFullYear();
    var d = date.getDate() + "." + (date.getMonth() + 1);
    var di = d + "." + Y;
    if (hL.hasOwnProperty(di)) return hL[di];
    var EasterDate;
    if (!easterYears.hasOwnProperty(Y.toString())) {
      easterYears[Y] = Easter(Y);
    }
    var a = easterYears[Y].split(".");
    for (var day in holidays) {
      if (d == day) {
        hL[di] = holidays[day];
        return holidays[day];
      } else if (day[0] == "-" || day[0] == "+") {
        var checkDay = new Date(Y, a[1] - 1, a[0]);
        checkDay.setDate(checkDay.getDate() + Number(day));
        checkDay = checkDay.getDate() + "." + (checkDay.getMonth() + 1);
        if (d == checkDay) {
          hL[di] = holidays[day];
          return holidays[day];
        }
      }
    }
    hL[di] = false;
    return false;
  }

  function period(delta) {
    var days = Math.floor(delta / 86400000);
    delta -= days * 86400000;
    var hours = Math.floor(delta / 3600000) % 24;
    if (days) return days.toString() + "d " + hours.toString() + "h";
    delta -= hours * 3600000;
    var minutes = Math.floor(delta / 60000) % 60;
    if (hours) return hours.toString() + "h " + minutes.toString() + "m";
    delta -= minutes * 60000;
    var seconds = Math.floor(delta / 1000);
    if (minutes) return minutes.toString() + "m " + seconds.toString() + "s";
    delta -= seconds * 1000;
    var ms = Math.floor(delta);
    if (seconds) return seconds.toString() + "s " + ms.toString() + "ms";
    delta -= ms;
    var us = Math.floor(delta * 1000);
    if (us) return ms.toString() + "ms " + us.toString() + "µs";
    return us.toString() + "µs";
  }

  //////////////////////////
  // data retrieval stuff //
  //////////////////////////

  initSources(settings.sources, {
    pushData(plot) { data.push(plot); },
    requestRedraw() { plotAll(); },
    getViewport() { return { tmin, tmax }; },
  });

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
      var t = mspp;
      if (mspp > 5000) t = 5000;
      timer(follow_view, t);
    }
    plotAll();
  }

  // navigate view to specific day, month or year (center current or go to left or right)
  function navigate(item, level, direction) {
    if (level == 4) {
      if (direction == "center")
        zoom(
          +item.tm,
          +new Date(new Date(+item.tm + f.d + 2 * f.h).toDateString()),
        );
      else if (direction == "left")
        zoom(+new Date(new Date(+item.tm - 2 * f.h).toDateString()), +item.tm);
      else
        zoom(
          +new Date(new Date(+item.tm + f.d + 2 * f.h).toDateString()),
          +new Date(new Date(+item.tm + 2 * f.d + 2 * f.h).toDateString()),
        );
      return;
    }
    if (level == 4.5) {
      zoom(
        +item.tm,
        +new Date(new Date(+item.tm + f.d * 7 + 2 * f.h).toDateString()),
      );
      return;
    }
    if (level == 5) {
      if (direction == "center") {
        var dm = new Date(+item.tm + f.mon + 2 * f.d);
        zoom(
          +item.tm,
          +new Date(
            Date.parse(
              dm.getFullYear() + "-" + (dm.getMonth() + 1) + "-1 00:00",
            ),
          ),
        );
      } else if (direction == "left") {
        var dm = new Date(+item.tm + -2 * f.d);
        zoom(
          +new Date(
            Date.parse(
              dm.getFullYear() + "-" + (dm.getMonth() + 1) + "-1 00:00",
            ),
          ),
          +item.tm,
        );
      } else {
        var dm = new Date(+item.tm + f.mon + 2 * f.d);
        var dm2 = new Date(+dm + f.mon + 2 * f.d);
        zoom(
          +new Date(
            Date.parse(
              dm.getFullYear() + "-" + (dm.getMonth() + 1) + "-1 00:00",
            ),
          ),
          +new Date(
            Date.parse(
              dm2.getFullYear() + "-" + (dm2.getMonth() + 1) + "-1 00:00",
            ),
          ),
        );
      }
      return;
    }
    if (level == 6) {
      if (direction == "center") {
        zoom(
          +item.tm,
          +new Date(Date.parse(item.tm.getFullYear() + 1 + "-1-1 00:00")),
        );
      } else if (direction == "left") {
        zoom(
          +new Date(Date.parse(item.tm.getFullYear() - 1 + "-1-1 00:00")),
          +item.tm,
        );
      } else {
        zoom(
          +new Date(Date.parse(item.tm.getFullYear() + 1 + "-1-1 00:00")),
          +new Date(Date.parse(item.tm.getFullYear() + 2 + "-1-1 00:00")),
        );
      }
      return;
    }
  }

  function zoom(target_tmin, target_tmax, time) {
    if (tmin == target_tmin && tmax == target_tmax) return;
    animation.startT = +Date.now() - 20;
    animation.endT = animation.startT + zoom_onclick_time;
    animation.start = {
      tmin: tmin,
      tmax: tmax,
    };
    animation.end = {
      tmin: target_tmin,
      tmax: target_tmax,
    };
    animate();
  }

  // today midnight
  function last_midnight() {
    var today = new Date(Date.now());
    return new Date(today.toDateString());
  }
  this.zoom = zoom;
  this.today = function () {
    var today = last_midnight();
    var tomorrow = new Date(today);
    tomorrow = new Date(tomorrow.setDate(tomorrow.getDate() + 1));
    zoom(today, tomorrow);
  };
  this.yesterday = function () {
    var today = last_midnight();
    var yesterday = new Date(today);
    yesterday = new Date(yesterday.setDate(yesterday.getDate() - 1));
    zoom(yesterday, today);
  };
  this.tomorrow = function () {
    var tomorrow = new Date(last_midnight());
    tomorrow = new Date(tomorrow.setDate(tomorrow.getDate() + 1));
    var dayafter = new Date(tomorrow);
    dayafter = new Date(dayafter.setDate(dayafter.getDate() + 1));
    zoom(tomorrow, dayafter);
  };
  this.last24 = function () {
    zoom(+Date.now() - 86400000, +Date.now());
  };
  this.next24 = function () {
    zoom(+Date.now(), +Date.now() + 86400000);
  };
  this.lastWeek = function () {
    var lastweek = new Date(last_midnight());
    lastweek = new Date(
      lastweek.setDate(lastweek.getDate() - 6 - lastweek.getDay()),
    );
    var thisweek = new Date(lastweek);
    thisweek = new Date(thisweek.setDate(thisweek.getDate() + 7));
    zoom(lastweek, thisweek);
  };
  this.thisWeek = function () {
    var thisweek = new Date(last_midnight());
    thisweek = new Date(
      thisweek.setDate(thisweek.getDate() + 1 - thisweek.getDay()),
    );
    var nextweek = new Date(thisweek);
    nextweek = new Date(nextweek.setDate(nextweek.getDate() + 7));
    zoom(thisweek, nextweek);
  };
  this.nextWeek = function () {
    var nextweek = new Date(last_midnight());
    nextweek = new Date(
      nextweek.setDate(nextweek.getDate() + 8 - nextweek.getDay()),
    );
    var weekafter = new Date(nextweek);
    weekafter = new Date(weekafter.setDate(weekafter.getDate() + 7));
    zoom(nextweek, weekafter);
  };

  function easeInOutExpo(x) {
    return x === 0
      ? 0
      : x === 1
        ? 1
        : x < 0.5
          ? Math.pow(2, 20 * x - 10) / 2
          : (2 - Math.pow(2, -20 * x + 10)) / 2;
  }

  function animate() {
    now = Date.now();
    var done = false;
    if (now >= animation.endT) {
      now = animation.endT;
      done = true;
    }
    t = easeInOutExpo(
      (now - animation.startT) / (animation.endT - animation.startT),
    );
    tmin = animation.start.tmin * (1 - t) + animation.end.tmin * t;
    tmax = animation.start.tmax * (1 - t) + animation.end.tmax * t;
    if (!done) setTimeout(animate, 10);
    plotAll();
  }

  function plotAll() {
    now = Date.now();
    c.clearRect(0, 0, canvas.width, canvas.height);
    prepare_grid(); // must run before rctx is built: recalculates ppms, ppv, ppv, mspp
    rctx = { c, X, Y, ppms, ppv, margin, plotWidth, plotHeight };
    background();
    yAxis();
    _plotData(activePlot, data, rctx);
    frame();
    redLine();
    // console.log('plot finished: ' + follow_timers);
    // console.log(grid);
    if (follow_timers < 0) timer(follow_view, 1000);
    c.fillText("1 Pixel = " + period(mspp), plotWidth - 60, 11);
  }

  window.onresize = function () {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    plotWidth = canvas.width - margin.left - margin.right;
    plotHeight = canvas.height - margin.top - margin.bottom;
    var BB = canvas.getBoundingClientRect();
    offset.x = BB.left;
    offset.y = BB.top;
    plotAll();
  };

  canvas.onmousedown = function (e) {
    var item = mouse_position(e);
    if (item.level) {
      var dir = "center";
      if (item.browse) {
        if (e.clientX - offset.x - margin.left < font_height) dir = "left";
        if (e.clientX - offset.x > plotWidth + margin.left - font_height)
          dir = "right";
      }
      navigate(item, item.level, dir);
    }
    if (item.key) {
      onClickData(data[item.plot], item.n, item.key);
    }
    startDragX = e.clientX;
    startTmin = tmin;
    startTmax = tmax;
  };

  canvas.onmousemove = function (e) {
    if (startDragX != 0) {
      canvas.style.cursor = 'grabbing';
      var move = ((startDragX - e.clientX) / plotWidth) * (tmax - tmin);
      tmin = startTmin + move;
      tmax = startTmax + move;
      plotAll();
      return;
    }
    var item = mouse_position(e);
    canvas.style.cursor =
      item && item !== 'frame' && (item.level || item.key) ? 'pointer' :
      item && item !== 'frame' ? 'grab' :
      'default';
  };

  canvas.onmouseup = function (e) {
    startDragX = 0;
  };

  canvas.onmouseout = function (e) {
    startDragX = 0;
    canvas.style.cursor = 'default';
  };

  var touchState = null;

  canvas.ontouchstart = function (e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      touchState = {
        type: 'pan',
        x0: e.touches[0].clientX,
        tmin0: tmin,
        tmax0: tmax,
      };
    } else if (e.touches.length === 2) {
      var cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      touchState = {
        type: 'pinch',
        dist0: Math.abs(e.touches[1].clientX - e.touches[0].clientX),
        midTime: rT(cx - offset.x),
        midFrac: (cx - offset.x - margin.left) / plotWidth,
        tmin0: tmin,
        tmax0: tmax,
      };
    }
  };

  canvas.ontouchmove = function (e) {
    e.preventDefault();
    if (!touchState) return;
    if (e.touches.length === 1 && touchState.type === 'pan') {
      var move = ((touchState.x0 - e.touches[0].clientX) / plotWidth) * (touchState.tmax0 - touchState.tmin0);
      tmin = touchState.tmin0 + move;
      tmax = touchState.tmax0 + move;
      plotAll();
    } else if (e.touches.length === 2 && touchState.type === 'pinch') {
      var dist = Math.abs(e.touches[1].clientX - e.touches[0].clientX);
      if (dist === 0) return;
      var scale = touchState.dist0 / dist;
      var newRange = (touchState.tmax0 - touchState.tmin0) * scale;
      tmin = touchState.midTime - touchState.midFrac * newRange;
      tmax = tmin + newRange;
      plotAll();
    }
  };

  canvas.ontouchend = function (e) {
    e.preventDefault();
    touchState = null;
  };

  canvas.onwheel = function (e) {
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
  };

  // how many tic to use for a given interval
  // p is defined array part10, part24 or part60
  // t is timeinterval in ms
  // d is minimum pixel distance allowed between tics
  function time_part(p, t, d) {
    for (var pp in p) if (ppms * t * p[pp] > d) return p[pp];
  }

  function mouse_position(e) {
    var x = e.clientX - offset.x;
    var y = e.clientY - offset.y;
    if (margin.left < x && x < plotWidth + margin.left) {
      if (margin.top < y && y < plotHeight + margin.top) {
        var weekitems = grid[4].filter((item) => item.tm.getDay() == 1);
        for (var wi of weekitems) {
          if (
            x > wi.x &&
            x < wi.x + c.measureText(wi.cw).width &&
            y > plotHeight + margin.top - font_height &&
            y < plotHeight + margin.top
          ) {
            var item = wi;
            return { cw: item.cw, level: 4.5 };
          }
        }
        // plot area
        return get_element(x, y);
      } else if (
        margin.top - 2 * font_height < y &&
        y < margin.top - font_height
      ) {
        // first label row
        var item = get_grid(x, grid_level_label[0][label_level]);
        item.y = margin.top - font_height;
        return item;
      }
      if (margin.top - font_height < y && y < margin.top) {
        // second label row
        var item = get_grid(x, grid_level_label[1][label_level]);
        item.y = margin.top;
        return item;
      }
    }
    // frame
    return "frame";
  }

  // return grid element of given canvas coordinates
  function get_grid(x, grid_level) {
    for (var j = 0; j < grid[grid_level].length; j++) {
      var item = grid[grid_level][j];
      if (item.x < x && x < item.x + item.len) {
        item.level = grid_level;
        return item;
      }
    }
  }

  // return data element of given canvas coordinates
  function get_element(x, y) {
    var t = new Date(rT(x));
    var py = rY(y);
    // multibar identification
    for (const i of activePlot)
      if (
        data[i].interval_start * 1000 <= t &&
        t <= data[i].interval_end * 1000
      ) {
        var n = Math.floor(
          (((+t - data[i].interval_start * 1000) /
            (data[i].interval_end - data[i].interval_start)) *
            data[i].count) /
            1000,
        );
        var h = 0;
        for (const [k, v] of Object.entries(data[i].data[n])) {
          if (py < h + v) {
            return {
              plot: i,
              n: n,
              key: k,
              value: v,
            };
          }
          h += v;
        }
      }
    return { t: t, y: py };
  }

  function plotpercentage(min, max) {
    if (min > tmax) min = tmax;
    if (min < tmin) min = tmin;
    if (max > tmax) max = tmax;
    if (max < tmin) max = tmin;
    return (max - min) / (tmax - tmin);
  }

  // create grid array containing all time labels
  function prepare_grid() {
    ppms = plotWidth / (tmax - tmin);
    mspp = 1 / ppms;
    var dtm = new Date(tmax);

    // find data that can be displayed and assign it to activePlot
    activePlot = [];
    var ymax_array = [];
    if (data.length)
      data.forEach((plot, i) => {
        plot.intervals = Object.keys(plot.data).length;
        plot.interval_end =
          plot.interval_start + plot.interval * plot.intervals;
        var pp = plotpercentage(
          plot.interval_start * 1000,
          plot.interval_end * 1000,
        );
        if (pp > 0) {
          activePlot.push(i);
          ymax_array.push([i, plot.max, pp]);
          ymin = 0;
        }
      });
    ymax_array.sort(function (first, second) {
      return second[1] - first[1];
    });
    if (ymax_array.length > 1) {
      var s = easeInOutExpo((ymax_array[0][2] / ymax_array[1][2]) * 4);
      ymax = s * ymax_array[0][1] + (1 - s) * ymax_array[1][1];
    } else if (ymax_array.length == 1) ymax = ymax_array[0][1];
    else ymax = 0;

    ygrid = [];
    if (ymax != 0) {
      ppv = plotHeight / (ymax - ymin);
      vpp = 1 / ppv;
      var s = vpp * font_height;
      var step = Math.pow(10, Math.ceil(Math.log10(s)));
      //if (s / step <= 0.2) step = 0.2 * step;
      if (s / step <= 0.5) step = 0.5 * step;
      for (var i = 0; i <= ymax; i += step) {
        ygrid.push({
          label: step > vpp * 2 * font_height || (i / step) % 2 == 0 ? i : "",
          y: i,
        });
      }
    }

    // milliseconds
    var part = time_part(part1000, 1, dvtl);
    var partl = time_part(part1000, 1, dtl);
    grid[0] = [];
    if (part)
      for (var t = Math.floor(tmin); t <= Math.ceil(tmax); t++) {
        if (t % part == 0) {
          var d = new Date(t);
          grid[0].push({
            tm: d,
            label:
              t % partl == 0 && t % 1000 > 0
                ? ":" +
                  String(d.getSeconds()).padStart(2, "0") +
                  "." +
                  String(d.getMilliseconds()).padStart(3, "0")
                : false,
            x: X(t),
            len: part * ppms,
            fill:
              part == 1
                ? t % 2
                  ? "rgba(240,240,240,0.5)"
                  : "rgba(196,196,196,0.5)"
                : false,
          });
        }
      }

    // seconds
    part = time_part(part60, f.s, dvtl);
    partl = time_part(part60, f.s, dtl);
    grid[1] = [];
    if (part)
      for (var t = Math.floor(tmin / f.s) * f.s; t <= tmax; t += f.s) {
        var d = new Date(t);
        var s = d / 1000;
        if (s % part == 0)
          grid[1].push({
            tm: d,
            label: s % partl == 0,
            x: X(t),
            len: part * ppms * f.s,
            fill:
              part == 1
                ? s % 2
                  ? "rgba(255,255,240,0.5)"
                  : "rgba(255,255,196,0.5)"
                : false,
          });
      }

    // minutes
    part = time_part(part60, f.m, dvtl);
    partl = time_part(part60, f.m, dtl);
    grid[2] = [];
    if (part)
      for (var t = Math.floor(tmin / f.m) * f.m; t <= tmax; t += f.m) {
        var d = new Date(t);
        var m = d.getMinutes();
        if (m % part == 0)
          grid[2].push({
            tm: d,
            label: m % partl == 0,
            x: X(t),
            len: part * ppms * f.m,
            fill:
              part == 1
                ? m % 2
                  ? "rgba(240,255,240,0.5)"
                  : "rgba(196,255,196,0.5)"
                : false,
          });
      }

    // hours
    grid[3] = [];
    part = time_part(part24, f.h, dvtl);
    partl = time_part(part24, f.h, dtl);
    var ds = f.h * part;
    if (part)
      for (var t = Math.floor(tmin / f.h) * f.h; t <= tmax; t += f.h) {
        var d = new Date(t);
        var h = d.getHours();
        if (h % part == 0)
          grid[3].push({
            tm: d,
            label: h % partl == 0,
            x: X(t),
            len: part * ppms * f.h,
            fill:
              part == 1
                ? h % 2
                  ? "rgba(240,240,255,0.5)"
                  : "rgba(196,196,255,0.5)"
                : false,
          });
      }

    // days
    grid[4] = [];
    var space = ppms * f.d;
    if (space > dvtl)
      for (
        var t = new Date(new Date(tmax).toDateString());
        t >= tmin - f.d;
        t = new Date(new Date(t - 12 * f.h).toDateString())
      ) {
        var x;
        if (t < tmin) x = margin.left;
        else x = X(t);
        var l = grid[4].length;
        var len;
        if (l) len = grid[4][l - 1].x - x;
        else len = canvas.width - margin.right - x;
        var h = isHoliday(t);
        var bh = h != false;
        if (h) {
          if (holiday_pixels[h] > len) h = label(t, "day", len);
          else
            h = (label(t, "day", len - holiday_pixels[h] - 5) + " " + h).trim();
        }
        var wd = t.getDay();
        var fill = "rgba(196,196,196,0.5)";
        if (wd == 0 || wd == 6 || bh) fill = "rgba(255,166,166,0.5)";
        else if (wd % 2) fill = "rgba(224,224,224,0.5)";
        grid[4].push({
          tm: t,
          label: h ? h : label(t, "day", len),
          x: x,
          len: len,
          fill: fill,
          cw: wd == 1 ? getWeek(t) : "",
          browse: t <= tmin && len + x >= canvas.width - margin.right,
        });
      }

    // months
    grid[5] = [];
    var space = ppms * f.d * 31;
    var dm = dtm;
    if (space > dvtl) {
      while (true) {
        t = new Date(
          Date.parse(dm.getFullYear() + "-" + (dm.getMonth() + 1) + "-1 00:00"),
        );
        if (t < tmin) x = margin.left;
        else x = X(t);
        l = grid[5].length;
        if (l) len = grid[5][l - 1].x - x;
        else len = canvas.width - margin.right - x;
        grid[5].push({
          tm: t,
          label: label(t, "month", len),
          x: x,
          len: len,
          fill:
            t.getMonth() % 2 ? "rgba(85,148,200,0.5)" : "rgba(240,240,240,0.5)",
          browse: t <= tmin && len + x >= canvas.width - margin.right,
        });
        dm = new Date(t - 1);
        if (dm < tmin) break;
      }
    }

    // years
    dm = dtm;
    grid[6] = [];
    var space = ppms * f.d * 365;
    if (space > dvtl) {
      for (
        t = new Date(Date.parse(dm.getFullYear() + "-1-1 00:00"));
        t >= tmin - 366 * f.d;
        t = new Date(
          Date.parse(new Date(t - 70 * f.d).getFullYear() + "-1-1 00:00"),
        )
      ) {
        if (t < tmin) x = margin.left;
        else x = X(t);
        l = grid[6].length;
        if (l) len = grid[6][l - 1].x - x;
        else len = canvas.width - margin.right - x;
        grid[6].push({
          tm: t,
          label: label(t, "year", len),
          x: x,
          len: len,
          fill:
            t.getFullYear() % 2
              ? "rgba(255,255,255,0.4)"
              : "rgba(240,240,240,0.4)",
          browse: t <= tmin && len + x >= canvas.width - margin.right,
        });
      }
    }

    if (labels.day_pixels[labels.day_pixels.length - 1] > ppms * f.d) {
      // year in top row, month in second row
      label_level = 1;
    } else {
      // month in top row, day in second row
      label_level = 0;
    }
  }

  function X(t) {
    return ((t - tmin) / (tmax - tmin)) * plotWidth + margin.left;
  }

  function rT(x) {
    return ((x - margin.left) / plotWidth) * (tmax - tmin) + tmin;
  }

  function Y(y) {
    return ((ymax - y) / (ymax - ymin)) * plotHeight + margin.top;
  }

  function rY(Y) {
    return ymax - ((Y - margin.top) / plotHeight) * (ymax - ymin);
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
      if (size > labels[format + "_pixels"][i])
        return date.toLocaleString(nls, labels[format][i]);
    return "";
  }

  function vertical_label(t, x, y) {
    var text = String(t.getHours()) + ":" + String(t.getMinutes()).padStart(2, "0");
    if (t % f.m > 0) text = ":" + String(t.getSeconds()).padStart(2, "0");
    if (t % 1000 > 0)
      text += "." + String(t.getMilliseconds()).padStart(3, "0");
    if (x >= margin.left) rotateText(text, x, y);
  }

  function horizontal_label(item, position) {
    c.textAlign = "center";
    c.textBaseline = "bottom";
    c.fillStyle = item.fill;
    c.fillRect(item.x, position - font_height, item.len, font_height);
    c.fillStyle = style.color;
    c.fillText(item.label, item.x + item.len / 2, position - 1);
    if (item.browse) {
      c.textAlign = "left";
      c.fillText("«", margin.left + 4, position - 1);
      c.textAlign = "right";
      c.fillText("»", canvas.width - margin.right - 4, position - 1);
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
    c.fillStyle = "white";
    c.fillRect(margin.left, margin.top, plotWidth, plotHeight);
    Object.keys(grid)
      .reverse()
      .forEach(function (layer) {
        grid[layer].forEach(function (item) {
          if (item.fill) {
            c.fillStyle = item.fill;
            c.fillRect(item.x, margin.top, item.len, plotHeight);
          }
          vertical_line(item.tm, "grey");
          if (item.cw) {
            c.textAlign = "left";
            var x = X(item.tm);
            if (x < margin.left) x = margin.left;
            c.fillStyle = "#888";
            c.textAlign = "left";
            c.textBaseline = "bottom";
            c.fillText(item.cw, x + 1, canvas.height - margin.bottom);
          }
        });
      });
  }

  function frame() {
    c.fillStyle = style.backgroundColor;
    c.fillRect(0, 0, canvas.width, margin.top);
    c.fillRect(0, margin.top, margin.left, canvas.height - margin.top);
    c.fillRect(
      margin.left,
      canvas.height - margin.bottom,
      canvas.width - margin.left,
      margin.bottom,
    );
    c.fillRect(
      canvas.width - margin.right,
      margin.top,
      margin.right,
      plotHeight,
    );
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
    c.textAlign = "right";
    c.textBaseline = "middle";
    for (var level = 0; level < 4; level++)
      grid[level].forEach((item, i) => {
        if (item.label)
          vertical_label(
            item.tm,
            X(item.tm),
            canvas.height - margin.bottom + 4,
          );
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
    c.fillStyle = style.color;
    c.font = style.font;
    c.textAlign = "right";
    c.textBaseline = "middle";
    ygrid.forEach((item, i) => {
      var y = Y(item.y);
      c.fillText(String(item.label), margin.left - 4, y);
    });
  }

  function yAxis() {
    c.strokeStyle = "#aaa";
    ygrid.forEach((item, i) => {
      var y = Y(item.y);
      c.beginPath();
      c.moveTo(margin.left, y);
      c.lineTo(margin.left + plotWidth, y);
      c.stroke();
    });
  }

  function redLine() {
    c.beginPath();
    c.moveTo(X(now), 0);
    c.lineTo(X(now), canvas.height);
    c.strokeStyle = "rgba(255,0,0,0.5)";
    c.stroke();
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.font = "0.65em Arial";
    c.fillStyle = "rgba(255,0,0, 0.5)";
    // rotateText(timezone, X(now), canvas.height);
    c.font = style.font;
    c.fillStyle = "black";
  }

  function fog_of_future() {
    if (now >= tmax) return;
    var x;
    if (now < tmin) x = margin.left;
    else x = X(now);
    c.fillStyle = "rgba(160,160,160, 0.4)";
    c.fillRect(x, margin.top, plotWidth, plotHeight);
  }

  // Snap tmax to now and start rolling (seismograph mode).
  // The existing follow_view() mechanism takes over once the view is aligned.
  this.followNow = function () {
    var range = tmax - tmin;
    now = Date.now();
    tmax = now;
    tmin = now - range;
    if (follow_timers === 0) timer(follow_view, 0);
    plotAll();
  };

  function onClickDataCallback(f) {
    onClickData = f;
  }

  this.onClickDataCallback = onClickDataCallback;
  TimeSeries.registerRenderer = registerRenderer;
  TimeSeries.registerSource = registerSource;

  follow_view();
}
