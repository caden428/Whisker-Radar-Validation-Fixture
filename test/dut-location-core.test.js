const assert = require('assert');
const DutLocationCore = require('../dut-location-core');

const location = DutLocationCore.DEFAULT_LOCATION;
assert.deepStrictEqual(DutLocationCore.geometry(location), {
  center: { x: 875, y: 1040 },
  bounds: { minX: 744, maxX: 1006, minY: 880, maxY: 1200 },
});
assert.deepStrictEqual(DutLocationCore.geometry(DutLocationCore.ORIGINAL_LOCATION), {
  center: { x: 875, y: 1260 },
  bounds: { minX: 744, maxX: 1006, minY: 1100, maxY: 1420 },
});
assert.deepStrictEqual(DutLocationCore.geometry(DutLocationCore.SINGLE_SENSOR_LOCATION), {
  center: { x: 875, y: 1200 },
  bounds: { minX: 875, maxX: 875, minY: 1200, maxY: 1200 },
});
assert.deepStrictEqual(DutLocationCore.geometry(DutLocationCore.SINGLE_SENSOR_DUT_LOCATION), {
  center: { x: 875, y: 1040 },
  bounds: { minX: 744, maxX: 1006, minY: 880, maxY: 1200 },
}, 'the in-unit single-sensor comparison target must retain the dual DUT footprint');
assert.strictEqual(DutLocationCore.segmentIntersectsNoGo({ x: 800, y: 1200 }, { x: 950, y: 1200 }, DutLocationCore.SINGLE_SENSOR_LOCATION), true);
assert.strictEqual(DutLocationCore.segmentIntersectsNoGo({ x: 800, y: 1199 }, { x: 950, y: 1199 }, DutLocationCore.SINGLE_SENSOR_LOCATION), false);
assert.strictEqual(DutLocationCore.pointInNoGo({ x: 875, y: 900 }, location), true);
assert.strictEqual(DutLocationCore.pointInNoGo({ x: 743.9, y: 900 }, location), false);
assert.strictEqual(DutLocationCore.pointInNoGo({ x: 743.9, y: 900 }, location, { clearanceMm: 1 }), true, 'reflector clearance must expand the keep-out envelope');
assert.strictEqual(DutLocationCore.segmentIntersectsNoGo({ x: 600, y: 900 }, { x: 1100, y: 900 }, location), true);
assert.strictEqual(DutLocationCore.segmentIntersectsNoGo({ x: 600, y: 800 }, { x: 1100, y: 800 }, location), false);
assert.strictEqual(DutLocationCore.segmentIntersectsNoGo({ x: 600, y: 880 }, { x: 744, y: 880 }, location), true);
assert.deepStrictEqual(DutLocationCore.safeRoute({ x: 600, y: 900 }, { x: 1100, y: 900 }, location), [
  { x: 743, y: 879 }, { x: 1007, y: 879 }, { x: 1100, y: 900 },
]);
const behindToFront = DutLocationCore.safeRoute({ x: 875, y: 1300 }, { x: 875, y: 800 }, location);
assert.ok(behindToFront.length >= 3, 'a move from behind to in front of the DUT needs corner waypoints');
let legStart = { x: 875, y: 1300 };
behindToFront.forEach((waypoint) => {
  assert.strictEqual(DutLocationCore.segmentIntersectsNoGo(legStart, waypoint, location), false, 'every routed leg must clear the DUT');
  legStart = waypoint;
});
const clearanceRoute = DutLocationCore.safeRoute({ x: 600, y: 900 }, { x: 1100, y: 900 }, location, { clearanceMm: 1, keepOutClearanceMm: 25 });
assert.ok(clearanceRoute.length >= 3, 'reflector-clearance routes must remain routable around the expanded keep-out');
let clearanceStart = { x: 600, y: 900 };
clearanceRoute.forEach((waypoint) => {
  assert.strictEqual(DutLocationCore.segmentIntersectsNoGo(clearanceStart, waypoint, location, { clearanceMm: 25 }), false, 'expanded keep-out route must remain clear');
  clearanceStart = waypoint;
});
const travelLimited = DutLocationCore.safeRoute(
  { x: 600, y: 1000 }, { x: 1100, y: 1000 }, location,
  { bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 } },
);
assert.ok(travelLimited.every((point) => point.y <= 1040), 'route waypoints must remain inside fixture travel');
assert.ok(travelLimited.some((point) => point.y < 880), 'travel-limited route must use the accessible front of the DUT');
assert.strictEqual(DutLocationCore.pointBehindDut({ x: 600, y: 1201 }, location), true, 'rear motion must be identified even beside the DUT');
assert.strictEqual(DutLocationCore.pointBehindDut({ x: 600, y: 1199 }, location), false, 'side positions must remain available up to the rear edge');
const frontOnlyRoute = DutLocationCore.safeRoute(
  { x: 600, y: 1000 }, { x: 1100, y: 1000 }, location,
  { bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 }, allowRear: false },
);
assert.ok(frontOnlyRoute.length >= 3, 'opposite-side DUT points need a routed path');
assert.ok(frontOnlyRoute.every((point) => point.y < 880 || point.y === 1000), 'front-only routing must never introduce a rear waypoint');
let frontOnlyStart = { x: 600, y: 1000 };
frontOnlyRoute.forEach((waypoint) => {
  assert.strictEqual(DutLocationCore.segmentIntersectsNoGo(frontOnlyStart, waypoint, location), false, 'every front-only routed leg must clear the DUT');
  frontOnlyStart = waypoint;
});
assert.deepStrictEqual(
  DutLocationCore.safeRoute({ x: 600, y: 1201 }, { x: 1100, y: 1000 }, location, { allowRear: false }),
  [],
  'front-only routing must reject a rear endpoint instead of falling back to an unsafe move',
);
const invalidKeepoutPlan = DutLocationCore.evaluatePlan(
  [{ pointId: 'inside', x: 875, y: 900 }], { x: 0, y: 0 }, location,
  { bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 }, allowRear: false, keepOutClearanceMm: 10 },
);
assert.strictEqual(invalidKeepoutPlan.safe, false);
assert.strictEqual(invalidKeepoutPlan.pointIssues[0].code, 'DUT_KEEP_OUT', 'plan evaluation must report the selected DUT keep-out violation');
const validAroundDutPlan = DutLocationCore.evaluatePlan(
  [{ pointId: 'left', x: 700, y: 1000 }, { pointId: 'right', x: 1050, y: 1000 }],
  { x: 0, y: 0 }, location,
  { bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 }, allowRear: false, keepOutClearanceMm: 10 },
);
assert.strictEqual(validAroundDutPlan.safe, true, 'valid side points must automatically route around the in-field DUT');
assert.strictEqual(validAroundDutPlan.ordered.length, 2, 'safe evaluation must retain every requested side point');
validAroundDutPlan.routes.forEach((route) => {
  let previous = route.from;
  route.waypoints.forEach((waypoint) => {
    assert.strictEqual(
      DutLocationCore.segmentIntersectsNoGo(previous, waypoint, location, { clearanceMm: 10 }),
      false,
      'evaluated routes must clear the complete reflector keep-out envelope',
    );
    previous = waypoint;
  });
});
const unordered = [
  { pointId: 'across-dut', x: 1100, y: 900 },
  { pointId: 'same-side', x: 600, y: 700 },
  { pointId: 'near-same-side', x: 620, y: 850 },
];
const nearestOrder = DutLocationCore.orderByNearestSafeRoute(unordered, { x: 600, y: 900 }, location, {
  bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 },
});
assert.deepStrictEqual(nearestOrder.map((point) => point.pointId), ['near-same-side', 'same-side', 'across-dut'], 'all tests must choose the nearest point by safe routed distance');
assert.deepStrictEqual(unordered.map((point) => point.pointId), ['across-dut', 'same-side', 'near-same-side'], 'ordering must not mutate the source plan');
const crossMapPlan = [
  [20,5],[7,16],[11,11],[8,5],[18,12],[8,16],[20,0],[14,15],[19,5],[12,11],[14,15],[18,18],
].map(([x,y], index) => ({ pointId: String(index+1), x, y }));
const crossMapOrder = DutLocationCore.orderByShortestSafeRoute(
  crossMapPlan, { x: 0, y: 0 }, { frontCenterX: 100, frontY: 100, widthMm: 0, depthMm: 0 },
);
const pathLength = (points) => {
  let previous = { x: 0, y: 0 }, total = 0;
  points.forEach((point) => { total += Math.hypot(point.x-previous.x, point.y-previous.y); previous = point; });
  return total;
};
assert.ok(pathLength(crossMapOrder) < 56, 'route-wide optimization must eliminate the avoidable greedy cross-map jump');
assert.strictEqual(crossMapOrder[0].pointId, '4', 'the closest collision-safe point to home must remain the first execution point');
assert.deepStrictEqual(new Set(crossMapOrder.map((point) => point.pointId)), new Set(crossMapPlan.map((point) => point.pointId)), 'global optimization must retain every test point exactly once');
console.log('DUT location core tests passed');
