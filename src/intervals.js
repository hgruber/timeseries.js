// Interval arithmetic utilities for timeseries.js
//
// a and b are arrays of intervals: [ [min_1,max_1], [min_2,max_2], .., [min_n,max_n] ]
// intervalSubtract(a,b) returns the difference a-b (array of intervals)
// intervalAdd(a,b)      returns the union a+b     (array of intervals)
// intervalIntersect(a,b)returns the intersection  (array of intervals)
// intervalLength(a)     returns the sum of interval lengths (scalar)
// intervalInvert(a)     returns the inverse of a  (array of intervals)
// getWeek(date)         returns the ISO week number for a Date object
//
// unit test examples:
// intervalAdd([[1,3],[8,10],[17,20]], [[2,11],[14,15]])  → [[1,11],[14,15],[17,20]]
// intervalSubtract([[1,3],[8,10],[17,20]], [[2,11],[14,15]])  → [[1,2],[17,20]]
// intervalIntersect([[1,3],[8,10],[17,20]], [[2,11],[14,15]])  → [[2,3],[8,10]]
// intervalLength([[1,3],[8,10],[17,20]])  → 7

export function intervalSubtract(a, b) {
  function difference(m, s) {
    if (s[1] <= m[0] || m[1] <= s[0]) return [m];
    if (s[1] < m[1]) {
      if (s[0] <= m[0]) return [[s[1], m[1]]];
      return [
        [m[0], s[0]],
        [s[1], m[1]],
      ];
    }
    if (s[0] <= m[0]) return [];
    return [[m[0], s[0]]];
  }

  function single(m, s) {
    var diff = [];
    m.forEach(function (md) {
      difference(md, s).forEach(function (ret) {
        diff.push(ret);
      });
    });
    return diff;
  }

  if (a === undefined || b === undefined) return [];
  var diff = a;
  b.forEach(function (m) {
    diff = single(diff, m);
  });
  return diff;
}

export function intervalInvert(a) {
  return intervalSubtract(
    [[Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]],
    a,
  );
}

export function intervalIntersect(a, b) {
  if (a === undefined || b === undefined) return [];
  return intervalSubtract(a, intervalInvert(b));
}

export function intervalAdd(a, b) {
  function sum(m, s) {
    if (s[1] < m[0]) return [s, m];
    if (m[1] < s[0]) return [m, s];
    if (s[1] < m[1]) {
      if (s[0] <= m[0]) return [[s[0], m[1]]];
      return [m];
    }
    if (s[0] <= m[0]) return [s];
    return [[m[0], s[1]]];
  }
  if (a === undefined || b === undefined) return [];
  var dummy = a.concat(b).sort(function (x, y) {
    return x[0] - y[0];
  });
  var result = dummy.slice();
  for (var i = 1; i < dummy.length; i++) {
    var s = sum(dummy[i - 1], dummy[i]);
    if (s.length === 1) {
      result.splice(0, 1);
      result[0] = s[0];
      dummy[i] = s[0];
    }
  }
  return result;
}

export function intervalLength(a) {
  var length = 0;
  a.forEach(function (o) {
    length = length + Number(o[1]) - Number(o[0]);
  });
  return length;
}

// ISO 8601 week number (weeks start on Monday; week 1 is the one containing
// the first Thursday of the year).
//
// Straight from that definition: step to the Thursday of `date`'s week, and
// count how many whole weeks separate it from 1 January of *that* Thursday's
// year. Working in UTC keeps the day arithmetic free of DST hour shifts.
export function getWeek(date) {
  var d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  // getUTCDay(): Sun=0 … Sat=6. Map Sunday to 7 so Monday=1 … Sunday=7, then
  // move to Thursday (day 4) of the same week.
  var isoDay = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  // That Thursday's year is the ISO week-numbering year, which is why late
  // December can land in week 1 and early January in week 52/53.
  var jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var daysSinceJan1 = (d - jan1) / 86400000;
  return Math.floor(daysSinceJan1 / 7) + 1;
}
