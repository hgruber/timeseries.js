// Largest Triangle Three Buckets (LTTB) downsampling algorithm.
//
// Reduces a PointSeries data array to at most `threshold` points while
// preserving the visual shape of the line.
//
// points    — PointSeries data array: Array<{ t: number, values: object }>
//             sorted ascending by t (ms)
// threshold — desired max number of output points (≥ 2)
// seriesId  — which series key to use for triangle area calculation
//             (defaults to the first key in points[0].values)
//
// Returns a new array in the same { t, values } format.

export function lttb(points, threshold, seriesId) {
  if (threshold >= points.length || threshold < 2) return points.slice();

  var id = seriesId !== undefined
    ? seriesId
    : Object.keys(points[0].values)[0];

  var sampled = [];
  // Always include first and last
  sampled.push(points[0]);

  var bucketSize = (points.length - 2) / (threshold - 2);
  var a = 0; // index of last selected point

  for (var i = 0; i < threshold - 2; i++) {
    // Calculate next bucket range
    var bucketStart = Math.floor((i + 1) * bucketSize) + 1;
    var bucketEnd   = Math.floor((i + 2) * bucketSize) + 1;
    if (bucketEnd >= points.length) bucketEnd = points.length - 1;

    // Calculate average point of the next bucket (lookahead)
    var avgT = 0, avgV = 0, avgCount = 0;
    for (var j = bucketStart; j < bucketEnd; j++) {
      var v = points[j].values[id];
      if (v != null) {
        avgT += points[j].t;
        avgV += v;
        avgCount++;
      }
    }
    if (avgCount > 0) { avgT /= avgCount; avgV /= avgCount; }

    // Current bucket range
    var curStart = Math.floor(i * bucketSize) + 1;
    var curEnd   = bucketStart;

    var pointA = points[a];
    var aT = pointA.t;
    var aV = pointA.values[id] || 0;

    // Find point in current bucket with largest triangle area
    var maxArea = -1;
    var maxIdx  = curStart;
    for (var k = curStart; k < curEnd; k++) {
      var kV = points[k].values[id];
      if (kV == null) continue;
      var area = Math.abs(
        (aT - avgT) * (kV - aV) -
        (aT - points[k].t) * (avgV - aV)
      ) * 0.5;
      if (area > maxArea) { maxArea = area; maxIdx = k; }
    }

    sampled.push(points[maxIdx]);
    a = maxIdx;
  }

  sampled.push(points[points.length - 1]);
  return sampled;
}
