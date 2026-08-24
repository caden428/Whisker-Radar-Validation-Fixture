(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DutLocationCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

const DEFAULT_LOCATION = Object.freeze({
  id: 'in-field-front-875-880',
  name: 'In-Field DUT — Front Edge (875, 880)',
  frontCenterX: 875,
  frontY: 880,
  widthMm: 262,
  depthMm: 320,
  depthDirection: 1,
});

const ORIGINAL_LOCATION = Object.freeze({
  id: 'original-front-875-1100',
  name: 'Original DUT — Front Edge (875, 1100)',
  frontCenterX: 875,
  frontY: 1100,
  widthMm: 262,
  depthMm: 320,
  depthDirection: 1,
});

const SINGLE_SENSOR_LOCATION = Object.freeze({
  id: 'single-sensor-875-1200',
  name: 'Stand-Mounted Single Sensor (875, 1200)',
  frontCenterX: 875,
  frontY: 1200,
  widthMm: 0,
  depthMm: 0,
  depthDirection: 1,
});

// The same physical enclosure as the Aqua dual-sensor DUT, populated with one
// sensor for the single-versus-dual comparison.  It is deliberately separate
// from DEFAULT_LOCATION so the selected test configuration remains explicit.
const SINGLE_SENSOR_DUT_LOCATION = Object.freeze({
  id: 'single-sensor-in-unit-front-875-880',
  name: 'In-Unit Single-Sensor DUT — Front Edge (875, 880)',
  frontCenterX: 875,
  frontY: 880,
  widthMm: 262,
  depthMm: 320,
  depthDirection: 1,
});

const BUILT_IN_LOCATIONS = Object.freeze([ORIGINAL_LOCATION, DEFAULT_LOCATION]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Returns the DUT center and exact physical footprint; no clearance is added. */
function geometry(location = DEFAULT_LOCATION) {
  const frontCenterX = finite(location.frontCenterX, DEFAULT_LOCATION.frontCenterX);
  const frontY = finite(location.frontY, DEFAULT_LOCATION.frontY);
  const widthMm = Math.abs(finite(location.widthMm, DEFAULT_LOCATION.widthMm));
  const depthMm = Math.abs(finite(location.depthMm, DEFAULT_LOCATION.depthMm));
  const direction = finite(location.depthDirection, 1) < 0 ? -1 : 1;
  const backY = frontY + direction * depthMm;
  return {
    center: { x: frontCenterX, y: frontY + direction * depthMm / 2 },
    bounds: {
      minX: frontCenterX - widthMm / 2,
      maxX: frontCenterX + widthMm / 2,
      minY: Math.min(frontY, backY),
      maxY: Math.max(frontY, backY),
    },
  };
}

function noGoBounds(location = DEFAULT_LOCATION, clearanceMm = 0) {
  const bounds = geometry(location).bounds;
  const clearance = Math.max(0, finite(clearanceMm, 0));
  return {
    minX: bounds.minX - clearance,
    maxX: bounds.maxX + clearance,
    minY: bounds.minY - clearance,
    maxY: bounds.maxY + clearance,
  };
}

function pointInNoGo(point, location = DEFAULT_LOCATION, options = {}) {
  const x = Number(point?.x), y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const bounds = noGoBounds(location, options.clearanceMm ?? 0);
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

/** Liang-Barsky intersection, with contact at the DUT boundary treated as blocked. */
function segmentIntersectsNoGo(start, end, location = DEFAULT_LOCATION, options = {}) {
  const x0 = Number(start?.x), y0 = Number(start?.y), x1 = Number(end?.x), y1 = Number(end?.y);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return false;
  const b = noGoBounds(location, options.clearanceMm ?? 0);
  const dx = x1 - x0, dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - b.minX, b.maxX - x0, y0 - b.minY, b.maxY - y0];
  let low = 0, high = 1;
  for (let index = 0; index < 4; index += 1) {
    if (p[index] === 0) {
      if (q[index] < 0) return false;
      continue;
    }
    const ratio = q[index] / p[index];
    if (p[index] < 0) low = Math.max(low, ratio);
    else high = Math.min(high, ratio);
    if (low > high) return false;
  }
  return true;
}

function pointWithinBounds(point, bounds = {}) {
  return (!Number.isFinite(Number(bounds.minX)) || point.x >= Number(bounds.minX))
    && (!Number.isFinite(Number(bounds.maxX)) || point.x <= Number(bounds.maxX))
    && (!Number.isFinite(Number(bounds.minY)) || point.y >= Number(bounds.minY))
    && (!Number.isFinite(Number(bounds.maxY)) || point.y <= Number(bounds.maxY));
}

function pointBehindDut(point, location = DEFAULT_LOCATION) {
  const y = Number(point?.y);
  if (!Number.isFinite(y)) return false;
  const bounds = geometry(location).bounds;
  const direction = finite(location?.depthDirection, 1) < 0 ? -1 : 1;
  return direction > 0 ? y > bounds.maxY : y < bounds.minY;
}

/**
 * Finds the shortest collision-free polyline through a visibility graph built
 * from the four corners just outside the DUT. Every returned leg is safe and
 * every waypoint stays inside the optional fixture travel bounds.
 */
function safeRoute(start, end, location = DEFAULT_LOCATION, options = {}) {
  const clearance = Math.max(0.001, finite(options.clearanceMm, 1));
  const keepOutClearance = Math.max(0, finite(options.keepOutClearanceMm, 0));
  const routeOptions = { clearanceMm: keepOutClearance };
  if (options.allowRear === false && (pointBehindDut(start, location) || pointBehindDut(end, location))) return [];
  if (!segmentIntersectsNoGo(start, end, location, routeOptions)) return [{ x: Number(end.x), y: Number(end.y) }];
  if (pointInNoGo(start, location, routeOptions) || pointInNoGo(end, location, routeOptions)) return [];
  const startPoint = { x: Number(start.x), y: Number(start.y) };
  const endPoint = { x: Number(end.x), y: Number(end.y) };
  const b = noGoBounds(location, keepOutClearance);
  let corners = [
    { x: b.minX-clearance, y: b.minY-clearance },
    { x: b.maxX+clearance, y: b.minY-clearance },
    { x: b.maxX+clearance, y: b.maxY+clearance },
    { x: b.minX-clearance, y: b.maxY+clearance },
  ];
  if (options.allowRear === false) {
    const direction = finite(location?.depthDirection, 1) < 0 ? -1 : 1;
    corners = direction > 0 ? corners.slice(0, 2) : corners.slice(2, 4);
  }
  corners = corners.filter((point) => pointWithinBounds(point, options.bounds));
  const nodes = [startPoint, endPoint, ...corners];
  const distance = nodes.map(() => Infinity);
  const previous = nodes.map(() => -1);
  const visited = nodes.map(() => false);
  distance[0] = 0;
  for (let step = 0; step < nodes.length; step += 1) {
    let current = -1;
    for (let index = 0; index < nodes.length; index += 1) {
      if (!visited[index] && (current < 0 || distance[index] < distance[current])) current = index;
    }
    if (current < 0 || !Number.isFinite(distance[current])) break;
    if (current === 1) break;
    visited[current] = true;
    for (let next = 0; next < nodes.length; next += 1) {
      if (next === current || visited[next] || segmentIntersectsNoGo(nodes[current], nodes[next], location, routeOptions)) continue;
      const candidate = distance[current] + Math.hypot(nodes[next].x-nodes[current].x, nodes[next].y-nodes[current].y);
      if (candidate < distance[next]) { distance[next] = candidate; previous[next] = current; }
    }
  }
  if (!Number.isFinite(distance[1])) return [];
  const indices = [];
  for (let index = 1; index >= 0; index = previous[index]) {
    indices.push(index);
    if (index === 0) break;
  }
  if (indices[indices.length-1] !== 0) return [];
  return indices.reverse().slice(1).map((index) => nodes[index]);
}

function routeLength(start, route) {
  let total = 0;
  let previous = { x: Number(start.x), y: Number(start.y) };
  for (const point of route) {
    total += Math.hypot(Number(point.x)-previous.x, Number(point.y)-previous.y);
    previous = { x: Number(point.x), y: Number(point.y) };
  }
  return total;
}

/**
 * Deterministically orders every test type by collision-safe travel distance,
 * then applies route-wide 2-opt improvements to remove avoidable crossings
 * and locally short but globally expensive jumps.
 */
function orderByNearestSafeRoute(points, start = { x: 0, y: 0 }, location = DEFAULT_LOCATION, options = {}) {
  const remaining = (Array.isArray(points) ? points : []).map((point, originalIndex) => ({ point, originalIndex }));
  const ordered = [];
  let current = { x: Number(start.x), y: Number(start.y) };
  while (remaining.length) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const route = safeRoute(current, remaining[index].point, location, options);
      if (!route.length) continue;
      const distance = routeLength(current, route);
      if (distance < bestDistance-1e-9
          || (Math.abs(distance-bestDistance) <= 1e-9
            && remaining[index].originalIndex < remaining[bestIndex]?.originalIndex)) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    if (bestIndex < 0) {
      if (options.rejectUnreachable === true) break;
      ordered.push(...remaining.map((entry) => entry.point));
      break;
    }
    const [selected] = remaining.splice(bestIndex, 1);
    ordered.push(selected.point);
    current = { x: Number(selected.point.x), y: Number(selected.point.y) };
  }
  // Nearest-safe ordering remains deterministic for large imported/generated
  // plans. The route-wide 2-opt pass is intentionally bounded because its
  // quadratic inner scan can otherwise lock the renderer on dense grids.
  if (ordered.length < 3 || ordered.length > 200) return ordered;
  const safeDistance = (from, to) => {
    const route = safeRoute(from, to, location, options);
    return route.length ? routeLength(from, route) : Infinity;
  };
  let improved = true;
  let passes = 0;
  const maxPasses = Math.max(4, Math.min(ordered.length * 2, 200));
  while (improved && passes < maxPasses) {
    improved = false;
    passes += 1;
    let bestGain = 1e-9, bestStart = -1, bestEnd = -1;
    // The first point is the collision-safe point closest to home. Keep that
    // anchor fixed while optimizing the remainder of the open trajectory.
    for (let first = 1; first < ordered.length-1; first += 1) {
      const previous = first === 0 ? start : ordered[first-1];
      for (let last = first+1; last < ordered.length; last += 1) {
        const next = last+1 < ordered.length ? ordered[last+1] : null;
        const oldCost = safeDistance(previous, ordered[first])
          + (next ? safeDistance(ordered[last], next) : 0);
        const newCost = safeDistance(previous, ordered[last])
          + (next ? safeDistance(ordered[first], next) : 0);
        const gain = oldCost-newCost;
        if (gain > bestGain) { bestGain = gain; bestStart = first; bestEnd = last; }
      }
    }
    if (bestStart >= 0) {
      const reversed = ordered.slice(bestStart, bestEnd+1).reverse();
      ordered.splice(bestStart, reversed.length, ...reversed);
      improved = true;
    }
  }
  return ordered;
}

const orderByShortestSafeRoute = orderByNearestSafeRoute;

/** Evaluates endpoints and every routed leg without silently accepting unreachable points. */
function evaluatePlan(points, start = { x: 0, y: 0 }, location = DEFAULT_LOCATION, options = {}) {
  const source = Array.isArray(points) ? points : [];
  const keepOutOptions = { clearanceMm: Math.max(0, finite(options.keepOutClearanceMm, 0)) };
  const pointIssues = [];
  source.forEach((point, index) => {
    const pointId = point?.pointId || index + 1;
    const x = Number(point?.x), y = Number(point?.y);
    if (![x, y].every(Number.isFinite)) pointIssues.push({ code: 'INVALID_COORDINATE', index, pointId, message: `Point ${pointId} has invalid coordinates` });
    else if (!pointWithinBounds({ x, y }, options.bounds)) pointIssues.push({ code: 'OUTSIDE_TRAVEL', index, pointId, message: `Point ${pointId} is outside fixture travel` });
    else if (pointInNoGo({ x, y }, location, keepOutOptions)) pointIssues.push({ code: 'DUT_KEEP_OUT', index, pointId, message: `Point ${pointId} is inside the DUT reflector keep-out` });
    else if (options.allowRear === false && pointBehindDut({ x, y }, location)) pointIssues.push({ code: 'REAR_FORBIDDEN', index, pointId, message: `Point ${pointId} is behind the DUT; rear motion is unavailable` });
  });
  if (pointIssues.length || !source.length) return { safe: false, ordered: [...source], routes: [], pointIssues, routeIssues: source.length ? [] : [{ code: 'EMPTY_PLAN', message: 'Plan contains no points' }] };

  const routeOptions = { ...options, rejectUnreachable: true };
  const ordered = orderByShortestSafeRoute(source, start, location, routeOptions);
  const routeIssues = [];
  if (ordered.length !== source.length) routeIssues.push({ code: 'UNREACHABLE_POINTS', message: `${source.length - ordered.length} point(s) have no collision-free front route` });
  const routes = [];
  let current = { x: Number(start.x), y: Number(start.y) };
  ordered.forEach((point, index) => {
    const waypoints = safeRoute(current, point, location, routeOptions);
    if (!waypoints.length) routeIssues.push({ code: 'UNREACHABLE_ROUTE', index, pointId: point.pointId || index + 1, message: `No collision-free front route exists to point ${point.pointId || index + 1}` });
    else routes.push({ from: { ...current }, to: { x: Number(point.x), y: Number(point.y) }, waypoints });
    current = { x: Number(point.x), y: Number(point.y) };
  });
  return { safe: !routeIssues.length, ordered: ordered.length === source.length ? ordered : [...source], routes, pointIssues, routeIssues };
}

return { DEFAULT_LOCATION, ORIGINAL_LOCATION, SINGLE_SENSOR_LOCATION, SINGLE_SENSOR_DUT_LOCATION, BUILT_IN_LOCATIONS, geometry, noGoBounds, pointInNoGo, segmentIntersectsNoGo, pointBehindDut, safeRoute, routeLength, evaluatePlan, orderByNearestSafeRoute, orderByShortestSafeRoute };
}));
