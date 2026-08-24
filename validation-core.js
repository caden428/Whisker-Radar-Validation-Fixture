(function validationCoreFactory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ValidationCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildValidationCore() {
  'use strict';

  const SCHEMA_VERSION = 3;
  const GEOMETRY_SEMANTICS = Object.freeze({
    SINGLE_SENSOR_LOBE: 'single-sensor-activation-lobe',
    DUAL_SYSTEM_BANDS: 'dual-sensor-system-distance-bands',
  });
  const SYSTEM_REQUIRED_TRIGGER_MM = 304.8;
  const SYSTEM_REQUIRED_NO_TRIGGER_MM = 609.6;
  function requiredTriggerMm(geometry) { return Math.max(0, finite(geometry?.requiredTriggerMm, SYSTEM_REQUIRED_TRIGGER_MM)); }
  function requiredNoTriggerMm(geometry) { return Math.max(requiredTriggerMm(geometry), finite(geometry?.requiredNoTriggerMm, SYSTEM_REQUIRED_NO_TRIGGER_MM)); }
  const ANGULAR_ZONES = Object.freeze({
    front: Object.freeze({ minDeg: -45, maxDeg: 45, label: 'Front' }),
    right: Object.freeze({ minDeg: 45, maxDeg: 90, label: 'Right' }),
    left: Object.freeze({ minDeg: -90, maxDeg: -45, label: 'Left' }),
  });
  const OUTCOME = Object.freeze({
    TRUE_POSITIVE: 'TP',
    TRUE_NEGATIVE: 'TN',
    FALSE_POSITIVE: 'FP',
    FALSE_NEGATIVE: 'FN',
    INVALID: 'INVALID',
    UNASSESSED: 'UNASSESSED',
  });

  // Digitized from the manual's dark, high-confidence detection lobe. Values
  // are normalized to the configured forward depth: [depth fraction, half-width
  // fraction]. The fixture mirrors the published profile about its centerline.
  const MANUAL_LOBE_PROFILE = Object.freeze([
    [0.00, 0.00], [0.07, 0.10], [0.14, 0.22], [0.23, 0.34],
    [0.34, 0.42], [0.45, 0.47], [0.57, 0.48], [0.68, 0.42],
    [0.80, 0.31], [0.91, 0.17], [1.00, 0.00],
  ].map(Object.freeze));

  const TEST_DEFINITIONS = Object.freeze({
    characterization: {
      id: 'characterization', version: 2, name: 'Trigger Zone Characterization',
      expected: 'observed-only', acceptance: null,
    },
    interference: {
      id: 'interference', version: 2, name: 'Radar Pair Interference Characterization',
      expected: 'observed-only', acceptance: null,
    },
    inside: {
      id: 'inside', version: 3, name: 'Test 10.1 — Inside Detection Validation',
      expected: true, acceptance: { minimumCorrectRate: 0.95, cyclesRequired: 3 },
    },
    outside: {
      id: 'outside', version: 3, name: 'Test 10.2 — Outside Boundary Validation',
      expected: false, acceptance: { minimumCorrectRate: 0.95, cyclesRequired: 3 },
    },
    system: {
      id: 'system', version: 1, name: 'System Level Bounds Validation',
      expected: 'system-bands', acceptance: { minimumCorrectRate: 0.95, cyclesRequired: 3 },
    },
    custom: {
      id: 'custom', version: 1, name: 'Custom Per-Point Validation',
      expected: null, acceptance: { minimumCorrectRate: 0.95, cyclesRequired: 1 },
    },
    sequence: {
      id: 'sequence', version: 1, name: 'Unscored Sequence',
      expected: null, acceptance: null,
    },
  });

  /** Implements the finite operation for this module. */
  function finite(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Implements the distance mm operation for this module. */
  function distanceMm(point, geometry) {
    const x = finite(point?.x);
    const y = finite(point?.y);
    const cx = finite(geometry?.centerX);
    const cy = finite(geometry?.centerY);
    if ([x, y, cx, cy].some((v) => v === null)) return null;
    return Math.hypot(x - cx, y - cy);
  }

  /** Identifies explicit geometry semantics without destructively migrating legacy definitions. */
  function geometrySemantics(geometry) {
    const explicit = String(geometry?.geometrySemantics || geometry?.semantics || '');
    if (explicit) return explicit;
    return String(geometry?.sensorLayout || 'single') === 'dual'
      ? GEOMETRY_SEMANTICS.DUAL_SYSTEM_BANDS
      : GEOMETRY_SEMANTICS.SINGLE_SENSOR_LOBE;
  }

  function usesDualSystemBands(geometry) {
    return String(geometry?.sensorLayout || 'single') === 'dual'
      && geometrySemantics(geometry) === GEOMETRY_SEMANTICS.DUAL_SYSTEM_BANDS;
  }

  /** Returns the explicit authoritative dual-system reference; never infers a sensor center. */
  function systemReferencePoint(geometry) {
    const reference = geometry?.systemReference || {};
    const x = finite(reference.x);
    const y = finite(reference.y);
    return x === null || y === null ? null : { x, y, confirmed: reference.confirmed === true };
  }

  /** Returns bearing in degrees with 0 straight ahead (-Y), right positive. */
  function forwardAngleDeg(point, geometry) {
    const reference = usesDualSystemBands(geometry)
      ? systemReferencePoint(geometry)
      : { x: finite(geometry?.centerX), y: finite(geometry?.centerY) };
    const x = finite(point?.x);
    const y = finite(point?.y);
    if (!reference || x === null || y === null || reference.x === null || reference.y === null) return null;
    return Math.atan2(x-reference.x, reference.y-y) * 180 / Math.PI;
  }

  /** Converts the approved map heading convention to a unit screen vector.
   * 0 degrees points down, negative angles left, and positive angles right. */
  function headingVector(angleDeg) {
    const radians = finite(angleDeg, 0) * Math.PI / 180;
    return { x: Math.sin(radians), y: -Math.cos(radians) };
  }

  /** Applies an optional front, right, or left angular-sector filter. */
  function pointInAngularZone(point, geometry, enabled = false, zone = 'front') {
    if (!enabled) return true;
    const limits = ANGULAR_ZONES[zone];
    const angle = forwardAngleDeg(point, geometry);
    return !!limits && angle !== null && angle >= limits.minDeg-1e-9 && angle <= limits.maxDeg+1e-9;
  }

  function systemFootprintBounds(geometry) {
    const bounds = geometry?.dut?.bounds;
    const minX = finite(bounds?.minX), maxX = finite(bounds?.maxX);
    const minY = finite(bounds?.minY), maxY = finite(bounds?.maxY);
    if ([minX,maxX,minY,maxY].some((value) => value === null) || minX >= maxX || minY >= maxY) return null;
    return { minX, maxX, minY, maxY };
  }

  function distanceToFootprintMm(point, bounds) {
    const x = finite(point?.x), y = finite(point?.y);
    if (!bounds || x === null || y === null) return null;
    const dx = Math.max(bounds.minX-x, 0, x-bounds.maxX);
    const dy = Math.max(bounds.minY-y, 0, y-bounds.maxY);
    return Math.hypot(dx, dy);
  }

  function systemDistanceMm(point, geometry) {
    const footprint = systemFootprintBounds(geometry);
    if (footprint) return distanceToFootprintMm(point, footprint);
    const reference = systemReferencePoint(geometry);
    const x = finite(point?.x);
    const y = finite(point?.y);
    if (!reference || x === null || y === null) return null;
    return Math.hypot(x - reference.x, y - reference.y);
  }

  /** Classifies exact ERD system-distance boundaries. */
  function classifySystemDistance(point, geometry) {
    const distance = systemDistanceMm(point, geometry);
    if (distance === null) return 'unknown';
    if (distance <= requiredTriggerMm(geometry) + 1e-9) return 'required-trigger';
    if (distance <= requiredNoTriggerMm(geometry) + 1e-9) return 'optional';
    return 'required-no-trigger';
  }

  function offsetRectangleBoundary(bounds, radiusMm, samples = 96) {
    const radius = Math.max(0, finite(radiusMm, 0));
    const perCorner = Math.max(3, Math.floor(Math.max(12, finite(samples, 96))/4));
    const corners = [
      { x: bounds.maxX, y: bounds.minY, start: -Math.PI/2 },
      { x: bounds.maxX, y: bounds.maxY, start: 0 },
      { x: bounds.minX, y: bounds.maxY, start: Math.PI/2 },
      { x: bounds.minX, y: bounds.minY, start: Math.PI },
    ];
    return corners.flatMap((corner) => Array.from({ length: perCorner }, (_, index) => {
      const angle = corner.start + (Math.PI/2)*index/(perCorner-1);
      return { x: corner.x + Math.cos(angle)*radius, y: corner.y + Math.sin(angle)*radius };
    }));
  }

  /** Returns footprint-offset system bands, with a circular fallback for historical geometry. */
  function systemBandBoundaries(geometry, samples = 96) {
    const footprint = systemFootprintBounds(geometry);
    if (footprint) return [requiredTriggerMm(geometry), requiredNoTriggerMm(geometry)]
      .map((radiusMm) => offsetRectangleBoundary(footprint, radiusMm, samples));
    const reference = systemReferencePoint(geometry);
    if (!reference) return [];
    const count = Math.max(12, Math.floor(finite(samples, 96)));
    return [requiredTriggerMm(geometry), requiredNoTriggerMm(geometry)].map((radiusMm) =>
      Array.from({ length: count }, (_, index) => {
        const angle = Math.PI * 2 * index / count;
        return { x: reference.x + Math.cos(angle) * radiusMm, y: reference.y + Math.sin(angle) * radiusMm };
      }));
  }

  /** Partitions system-level coverage without assigning points to either sensor. */
  function systemCoveragePartition(point, geometry) {
    const reference = systemReferencePoint(geometry);
    if (!reference) return 'Overall';
    const dx = Number(point?.x) - reference.x;
    const dy = Number(point?.y) - reference.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'Overall';
    if (Math.abs(dx) <= Math.abs(dy)) return 'Front';
    return dx < 0 ? 'Left' : 'Right';
  }

  const PERIMETER_COVERAGE_MODES = Object.freeze(['front', 'full-dut']);
  const PERIMETER_SIDES = Object.freeze(['front', 'left', 'right']);

  function perimeterSides(options = {}) {
    return options.coverageMode === 'front' ? ['front'] : ['front', 'left', 'right'];
  }

  function distributePerimeterCounts(count, sides, quotas = {}) {
    const result = Object.fromEntries(sides.map((side) => [side, 0]));
    let remaining = count;
    sides.forEach((side) => {
      const quota = Math.max(0, Math.floor(finite(quotas?.[side], 0)));
      result[side] = Math.min(quota, remaining);
      remaining -= result[side];
    });
    let index = 0;
    while (remaining > 0 && sides.length) {
      result[sides[index % sides.length]] += 1;
      remaining -= 1;
      index += 1;
    }
    return result;
  }

  /** Generates deterministic grid-like points on selected DUT perimeter sides. */
  function generatePerimeterPoints(options = {}) {
    const count = Math.max(1, Math.floor(finite(options.count, 100)));
    const geometry = options.geometry || {};
    const footprint = systemFootprintBounds(geometry);
    if (!footprint) return [];
    const inside = options.zone === 'inside';
    const trigger = requiredTriggerMm(geometry);
    const noTrigger = requiredNoTriggerMm(geometry);
    const outer = inside ? trigger : Math.max(noTrigger + 1, finite(options.outerRadiusMm, noTrigger * 1.25));
    const keepOut = Math.max(0, finite(options.keepOutClearanceMm, 0));
    const sides = perimeterSides(options);
    const counts = distributePerimeterCounts(count, sides, options.sideQuotas);
    const bounds = options.bounds || {};
    const lineXMin = Math.max(footprint.minX, Number.isFinite(bounds.minX) ? bounds.minX : footprint.minX);
    const lineXMax = Math.min(footprint.maxX, Number.isFinite(bounds.maxX) ? bounds.maxX : footprint.maxX);
    const lineYMin = Math.max(footprint.minY, Number.isFinite(bounds.minY) ? bounds.minY : footprint.minY);
    const lineYMax = Math.min(footprint.maxY, Number.isFinite(bounds.maxY) ? bounds.maxY : footprint.maxY);
    const points = [];
    const allowed = (point) => (!Number.isFinite(bounds.minX) || point.x >= bounds.minX)
      && (!Number.isFinite(bounds.maxX) || point.x <= bounds.maxX)
      && (!Number.isFinite(bounds.minY) || point.y >= bounds.minY)
      && (!Number.isFinite(bounds.maxY) || point.y <= bounds.maxY)
      && (!options.isPointAllowed || options.isPointAllowed(point));
    const layers = [0.38, 0.64, 0.9];
    const candidatesBySide = Object.fromEntries(sides.map((side) => [side, []]));
    const seenBySide = Object.fromEntries(sides.map((side) => [side, new Set()]));
    sides.forEach((side) => {
      const sideCount = counts[side];
      const samples = Math.max(48, sideCount * 24);
      for (let index = 0; index < samples; index += 1) {
        const fraction = (index + 1) / (samples + 1);
        const layer = layers[index % layers.length];
        const distance = inside
          ? Math.max(keepOut + 0.5, outer * layer)
          : noTrigger + Math.max(0.5, (outer - noTrigger) * layer);
        const point = side === 'front'
          ? { x: lineXMin + (lineXMax - lineXMin) * fraction, y: footprint.minY - distance }
            : side === 'left'
            ? { x: footprint.minX - distance, y: lineYMin + (lineYMax - lineYMin) * fraction }
              : { x: footprint.maxX + distance, y: lineYMin + (lineYMax - lineYMin) * fraction };
        const rounded = { x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000 };
        const distanceFromDut = systemDistanceMm(rounded, geometry);
        const validBand = inside
          ? distanceFromDut > keepOut && distanceFromDut <= trigger + 1e-6
          : distanceFromDut > noTrigger + 1e-6 && distanceFromDut <= outer + 1e-6;
        if (!validBand || !allowed(rounded)) continue;
        const key = `${rounded.x},${rounded.y}`;
        if (seenBySide[side].has(key)) continue;
        seenBySide[side].add(key);
        candidatesBySide[side].push({ ...rounded, z: finite(options.z, 0), holdMs: Math.max(0, finite(options.holdMs, 1000)), expectedDetected: inside, zone: inside ? 'required-trigger' : 'required-no-trigger', coveragePartition: side[0].toUpperCase() + side.slice(1), coverageSide: side });
      }
    });

    const usedBySide = Object.fromEntries(sides.map((side) => [side, new Set()]));
    sides.forEach((side) => {
      const quota = Math.min(counts[side], candidatesBySide[side].length);
      for (let index = 0; index < quota; index += 1) {
        const sourceIndex = Math.min(candidatesBySide[side].length - 1,
          Math.floor((index + 0.5) * candidatesBySide[side].length / quota));
        points.push(candidatesBySide[side][sourceIndex]);
        usedBySide[side].add(sourceIndex);
      }
    });

    // Preserve each side's requested quota first. Only redistribute a shortfall
    // when that side has no more physically valid candidates.
    while (points.length < count) {
      let added = false;
      for (const side of sides) {
        const sourceIndex = candidatesBySide[side].findIndex((_, index) => !usedBySide[side].has(index));
        if (sourceIndex < 0) continue;
        points.push(candidatesBySide[side][sourceIndex]);
        usedBySide[side].add(sourceIndex);
        added = true;
        if (points.length === count) break;
      }
      if (!added) break;
    }
    return points;
  }

  /** Implements the manual lobe half width operation for this module. */
  function manualLobeHalfWidth(depthMm, lobeDepthMm) {
    const extent = Math.max(0, finite(lobeDepthMm, 0));
    const depth = finite(depthMm);
    if (!extent || depth === null || depth < 0 || depth > extent) return 0;
    const normalized = depth / extent;
    for (let index = 1; index < MANUAL_LOBE_PROFILE.length; index++) {
      const [d1, w1] = MANUAL_LOBE_PROFILE[index];
      if (normalized > d1) continue;
      const [d0, w0] = MANUAL_LOBE_PROFILE[index - 1];
      const t = (normalized - d0) / Math.max(1e-9, d1 - d0);
      return extent * (w0 + (w1 - w0) * t);
    }
    return 0;
  }

  /** Tests whether an X/Y point lies inside the configured tapered lobe. */
  function pointInManualLobe(point, geometry, lobeDepthMm = finite(geometry?.radiusMm, 304.8)) {
    const x = finite(point?.x);
    const y = finite(point?.y);
    const centerX = finite(geometry?.centerX);
    const centerY = finite(geometry?.centerY);
    const rotationRad = finite(geometry?.rotationDeg, 0) * Math.PI / 180;
    const extent = Math.max(0, finite(lobeDepthMm, 0));
    if ([x, y, centerX, centerY].some((value) => value === null) || !extent) return false;
    const worldX = x - centerX;
    const worldY = y - centerY;
    const localX = worldX * Math.cos(rotationRad) + worldY * Math.sin(rotationRad);
    const localY = -worldX * Math.sin(rotationRad) + worldY * Math.cos(rotationRad);
    const depth = -localY;
    if (depth < -1e-6 || depth > extent + 1e-6) return false;
    const halfWidth = manualLobeHalfWidth(Math.max(0, Math.min(extent, depth)), extent);
    return Math.abs(localX) <= halfWidth + 1e-6;
  }

  /** Samples the configured tapered detection-lobe perimeter. */
  function manualLobeBoundary(geometry, lobeDepthMm = finite(geometry?.radiusMm, 304.8), samples = 48) {
    const centerX = finite(geometry?.centerX, 0);
    const centerY = finite(geometry?.centerY, 0);
    const rotationRad = finite(geometry?.rotationDeg, 0) * Math.PI / 180;
    const extent = Math.max(0, finite(lobeDepthMm, 0));
    const count = Math.max(2, Math.floor(finite(samples, 48)));
    const right = [];
    for (let index = 0; index <= count; index++) {
      const depth = extent * index / count;
      const localX = manualLobeHalfWidth(depth, extent);
      const localY = -depth;
      right.push({
        x: centerX + localX * Math.cos(rotationRad) - localY * Math.sin(rotationRad),
        y: centerY + localX * Math.sin(rotationRad) + localY * Math.cos(rotationRad),
      });
    }
    const left = [];
    for (let index = count - 1; index >= 1; index--) {
      const depth = extent * index / count;
      const localX = -manualLobeHalfWidth(depth, extent);
      const localY = -depth;
      left.push({
        x: centerX + localX * Math.cos(rotationRad) - localY * Math.sin(rotationRad),
        y: centerY + localX * Math.sin(rotationRad) + localY * Math.cos(rotationRad),
      });
    }
    return right.concat(left);
  }

  /** Returns the stand-mounted sensor lobe used only by single-sensor mode. */
  function activationSensors(geometry) {
    return [{
      centerX: finite(geometry?.centerX, 0),
      centerY: finite(geometry?.centerY, 0),
      radiusMm: Math.max(0, finite(geometry?.radiusMm, 304.8)),
      rotationDeg: 0,
    }];
  }

  /** Tests the union of every configured sensor lobe, with an optional depth adjustment. */
  function pointInActivationZone(point, geometry, depthAdjustmentMm = 0) {
    if (usesDualSystemBands(geometry)) {
      const distance = systemDistanceMm(point, geometry);
      return distance !== null && distance <= Math.max(0, requiredTriggerMm(geometry) + finite(depthAdjustmentMm, 0)) + 1e-6;
    }
    const adjustment = finite(depthAdjustmentMm, 0);
    return activationSensors(geometry).some((sensor) =>
      pointInManualLobe(point, sensor, Math.max(0, sensor.radiusMm + adjustment)));
  }

  /** Samples each sensor-lobe perimeter in the configured system activation zone. */
  function activationZoneBoundaries(geometry, depthAdjustmentMm = 0, samples = 48) {
    if (usesDualSystemBands(geometry)) {
      const footprint = systemFootprintBounds(geometry);
      const radiusMm = Math.max(0, requiredTriggerMm(geometry) + finite(depthAdjustmentMm, 0));
      if (footprint) return [offsetRectangleBoundary(footprint, radiusMm, samples)];
      const reference = systemReferencePoint(geometry);
      if (!reference) return [];
      const count = Math.max(12, Math.floor(finite(samples, 48)));
      return [Array.from({ length: count }, (_, index) => {
        const angle = Math.PI * 2 * index / count;
        return { x: reference.x + Math.cos(angle) * radiusMm, y: reference.y + Math.sin(angle) * radiusMm };
      })];
    }
    const adjustment = finite(depthAdjustmentMm, 0);
    return activationSensors(geometry).map((sensor) =>
      manualLobeBoundary(sensor, Math.max(0, sensor.radiusMm + adjustment), samples));
  }

  /** Returns the shortest linear distance from a point to supplied closed perimeters. */
  function distanceToBoundaries(point, boundaries) {
    const x = finite(point?.x);
    const y = finite(point?.y);
    if (x === null || y === null) return Infinity;
    let closest = Infinity;
    boundaries.forEach((boundary) => {
      boundary.forEach((start, index) => {
        const end = boundary[(index + 1) % boundary.length];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared
          ? Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared))
          : 0;
        closest = Math.min(closest, Math.hypot(x - (start.x + t * dx), y - (start.y + t * dy)));
      });
    });
    return closest;
  }

  /** Returns the shortest linear distance from a point to the activation-zone perimeter. */
  function distanceToActivationZoneBoundary(point, geometry, samples = 192) {
    return distanceToBoundaries(point, activationZoneBoundaries(geometry, 0, samples));
  }

  /** Classifies zone. */
  function classifyZone(pointOrDistance, geometry) {
    // Numeric input remains supported for old result readers; all current plan
    // generation and scoring pass an XY point and use the manual lobe.
    if (Number.isFinite(pointOrDistance)) {
      const distance = pointOrDistance;
      const radius = Math.max(0, finite(geometry?.radiusMm, 304.8));
      const guard = Math.max(0, finite(geometry?.guardBandMm, 0));
      if (Math.abs(distance - radius) <= guard) return 'guard-band';
      return distance < radius ? 'inside' : 'outside';
    }
    if (!pointOrDistance || !Number.isFinite(Number(pointOrDistance.x)) || !Number.isFinite(Number(pointOrDistance.y))) return 'unknown';
    if (usesDualSystemBands(geometry)) return classifySystemDistance(pointOrDistance, geometry);
    const guard = Math.max(0, finite(geometry?.guardBandMm, 0));
    if (pointInActivationZone(pointOrDistance, geometry)) return 'inside';
    return guard && distanceToActivationZoneBoundary(pointOrDistance, geometry) <= guard + 1e-6
      ? 'guard-band' : 'outside';
  }

  /** Applies test-specific inside, outside, and guard-band semantics. */
  function classifyZoneForTest(testId, point, geometry) {
    if (usesDualSystemBands(geometry)) return classifySystemDistance(point, geometry);
    if (testId === 'inside') {
      return pointInActivationZone(point, geometry) ? 'inside' : 'outside';
    }
    return classifyZone(point, geometry);
  }

  /** Implements the expected for operation for this module. */
  function expectedFor(testId, point, geometry) {
    const def = TEST_DEFINITIONS[testId] || TEST_DEFINITIONS.sequence;
    if (def.expected === 'observed-only') return null;
    if (usesDualSystemBands(geometry) && ['inside', 'outside', 'custom', 'system'].includes(testId)) {
      const zone = classifySystemDistance(point, geometry);
      if (zone === 'required-trigger') return true;
      if (zone === 'required-no-trigger') return false;
      return null;
    }
    if (typeof def.expected === 'boolean') return def.expected;
    if (def.expected === 'geometry') {
      const zone = classifyZoneForTest(testId, point, geometry);
      if (zone === 'inside') return true;
      if (zone === 'outside') return false;
    }
    if (typeof point?.expectedDetected === 'boolean') return point.expectedDetected;
    return null;
  }

  /** Returns all geometry and expectation problems in a proposed test plan. */
  function validatePlan(testId, points, geometry) {
    const issues = [];
    if (!Array.isArray(points) || !points.length) return [{ code: 'EMPTY_PLAN', message: 'Test plan contains no positions' }];
    points.forEach((point, index) => {
      const distance = usesDualSystemBands(geometry) ? systemDistanceMm(point, geometry) : distanceMm(point, geometry);
      const zone = classifyZoneForTest(testId, point, geometry);
      if (distance === null) issues.push({ code: 'INVALID_COORDINATE', index, message: `Point ${index + 1} has invalid coordinates or radar geometry` });
      const origins = activationSensors(geometry);
      if (!usesDualSystemBands(geometry) && ['inside', 'outside'].includes(testId) && origins.every((sensor) => Number(point.y) > sensor.centerY + 1e-6)) {
        issues.push({ code: 'WRONG_HEMISPHERE', index, message: `Point ${index + 1} is behind the radar origin instead of inside the forward lobe` });
      }
      const expectedZone = usesDualSystemBands(geometry)
        ? (testId === 'inside' ? 'required-trigger' : 'required-no-trigger')
        : (testId === 'inside' ? 'inside' : 'outside');
      if (['inside', 'outside'].includes(testId) && zone !== expectedZone) {
        issues.push({ code: 'WRONG_ZONE', index, zone, message: `Point ${index + 1} is ${zone}, not ${expectedZone}` });
      }
      // System Level Custom plans derive their expectation from the selected
      // DUT footprint and green/grey/red bounds. The grey band is deliberately
      // ungraded; every other custom workflow still requires an explicit value.
      if (testId === 'system' && !usesDualSystemBands(geometry)) {
        issues.push({ code: 'SYSTEM_LAYOUT_REQUIRED', index, message: 'System Level Bounds Validation requires the Aqua dual-sensor DUT setup' });
      }
      if (testId === 'custom' && !usesDualSystemBands(geometry) && typeof point.expectedDetected !== 'boolean') {
        issues.push({ code: 'MISSING_EXPECTATION', index, message: `Point ${index + 1} has no expectedDetected value` });
      }
    });
    return issues;
  }

  /** Classifies the requested operation. */
  function classify(expectedDetected, actualDetected, valid = true) {
    if (!valid) return OUTCOME.INVALID;
    if (typeof expectedDetected !== 'boolean' || typeof actualDetected !== 'boolean') return OUTCOME.UNASSESSED;
    if (expectedDetected) return actualDetected ? OUTCOME.TRUE_POSITIVE : OUTCOME.FALSE_NEGATIVE;
    return actualDetected ? OUTCOME.FALSE_POSITIVE : OUTCOME.TRUE_NEGATIVE;
  }

  /** Creates one canonical, classified observation record. */
  function createObservation(input) {
    const geometry = input.geometry || {};
    const dist = usesDualSystemBands(geometry) ? systemDistanceMm(input, geometry) : distanceMm(input, geometry);
    const zone = ['inside', 'outside'].includes(input.testId)
      ? classifyZoneForTest(input.testId, input, geometry)
      : input.zone || classifyZoneForTest(input.testId, input, geometry);
    const expected = expectedFor(input.testId, input, geometry);
    const actual = typeof input.actualDetected === 'boolean' ? input.actualDetected : null;
    const valid = input.valid !== false;
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: String(input.runId || ''),
      testId: String(input.testId || 'sequence'),
      testVersion: finite(input.testVersion, 1),
      dutId: String(input.dutId || ''),
      cycleNumber: finite(input.cycleNumber, 1),
      pointId: String(input.pointId ?? input.positionIndex ?? ''),
      positionIndex: finite(input.positionIndex),
      attemptNumber: finite(input.attemptNumber, 1),
      x: finite(input.x), y: finite(input.y), z: finite(input.z, 0),
      distanceMm: dist === null ? null : Math.round(dist * 1000) / 1000,
      zone,
      coveragePartition: usesDualSystemBands(geometry) ? systemCoveragePartition(input, geometry) : '',
      expectedDetected: expected,
      actualDetected: actual,
      radarAActualDetected: typeof input.radarAActualDetected === 'boolean' ? input.radarAActualDetected : null,
      radarBActualDetected: typeof input.radarBActualDetected === 'boolean' ? input.radarBActualDetected : null,
      singleRadarActualDetected: typeof input.singleRadarActualDetected === 'boolean' ? input.singleRadarActualDetected : null,
      ld021AActualDetected: typeof input.ld021AActualDetected === 'boolean' ? input.ld021AActualDetected : null,
      ld021BActualDetected: typeof input.ld021BActualDetected === 'boolean' ? input.ld021BActualDetected : null,
      triggeredSensors: String(input.triggeredSensors || triggeredSensorLabel(
        input.radarAActualDetected ?? input.ld021AActualDetected,
        input.radarBActualDetected ?? input.ld021BActualDetected,
      )),
      ld021ARisingEdgeMs: finite(input.ld021ARisingEdgeMs),
      ld021AFallingEdgeMs: finite(input.ld021AFallingEdgeMs),
      ld021BRisingEdgeMs: finite(input.ld021BRisingEdgeMs),
      ld021BFallingEdgeMs: finite(input.ld021BFallingEdgeMs),
      testPhase: String(input.testPhase || ''),
      powerAState: input.powerAState == null ? '' : String(input.powerAState),
      powerBState: input.powerBState == null ? '' : String(input.powerBState),
      activeRadarTarget: String(input.activeRadarTarget || ''),
      combinedDetectionRule: String(input.combinedDetectionRule || ''),
      outcome: classify(expected, actual, valid),
      detectionLatencyMs: actual === true ? finite(input.detectionLatencyMs) : null,
      moveDurationMs: finite(input.moveDurationMs),
      timestamp: input.timestamp || new Date().toISOString(),
      valid,
      invalidReason: valid ? '' : String(input.invalidReason || 'Unspecified invalid measurement'),
      notes: String(input.notes || ''),
    };
  }

  /** Labels the independent pair outputs captured for one interference point. */
  function triggeredSensorLabel(sensorA, sensorB) {
    if (sensorA === true && sensorB === true) return 'Both';
    if (sensorA === true) return 'A';
    if (sensorB === true) return 'B';
    if (sensorA === false && sensorB === false) return 'Neither';
    return 'Unknown';
  }

  /** Aggregates observations into counts, rates, cycle completion, and acceptance. */
  function summarize(observations, definition) {
    // Acquisition retries are retained in the raw log, but a valid retry replaces
    // its invalid predecessor for acceptance.  A point/cycle with no valid retry
    // remains invalid.
    const effective = effectiveObservations(observations);
    const counts = { TP: 0, TN: 0, FP: 0, FN: 0, INVALID: 0, UNASSESSED: 0 };
    effective.forEach((o) => { counts[o.outcome] = (counts[o.outcome] || 0) + 1; });
    const correct = counts.TP + counts.TN;
    const incorrect = counts.FP + counts.FN;
    const assessed = correct + incorrect;
    const rate = assessed ? correct / assessed : null;
    const cycles = [...new Set(effective.filter((o) => o.valid).map((o) => o.cycleNumber))];
    const acceptance = definition?.acceptance || null;
    const cyclesComplete = !acceptance || cycles.length >= acceptance.cyclesRequired;
    const accepted = acceptance ? assessed > 0 && rate >= acceptance.minimumCorrectRate && cyclesComplete && counts.INVALID === 0 : null;
    return { total: observations.length, effectiveTotal: effective.length, assessed, correct, incorrect, counts, correctRate: rate, cyclesCompleted: cycles.length, cyclesComplete, accepted };
  }

  /** Selects the final valid measurement for each planned point/cycle, if any. */
  function effectiveObservations(observations) {
    const groups = new Map();
    (observations || []).forEach((observation) => {
      const key = `${finite(observation?.cycleNumber, 1)}::${pointAggregationKey(observation)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(observation);
    });
    return [...groups.values()].map((group) => {
      const valid = group.filter((observation) => observation.valid !== false);
      const invalid = group.filter((observation) => observation.valid === false);
      const attempt = (observation) => finite(observation?.attemptNumber, 1);
      const latestValid = valid.reduce((best, item) => !best || attempt(item) >= attempt(best) ? item : best, null);
      const latestInvalid = invalid.reduce((best, item) => !best || attempt(item) >= attempt(best) ? item : best, null);
      // A valid measurement only resolves an invalid predecessor when it is a
      // later numbered retry. Equal-attempt imported/duplicate rows remain
      // invalid rather than silently masking an acquisition failure.
      if (latestValid && (!latestInvalid || attempt(latestValid) > attempt(latestInvalid))) return latestValid;
      return latestInvalid || latestValid || group[group.length - 1];
    });
  }

  /** Returns a stable identity for repeated observations of one physical point. */
  function pointAggregationKey(observation) {
    const x = finite(observation?.x);
    const y = finite(observation?.y);
    const coordinate = `${x === null ? 'x' : x.toFixed(3)},${y === null ? 'y' : y.toFixed(3)}`;
    return `${String(observation?.pointId || 'point')}@${coordinate}`;
  }

  /** Reduces repeated cycle observations to one majority result per physical point. */
  function aggregateByPoint(observations, cyclesPlanned = 1) {
    const groups = new Map();
    (observations || []).forEach((observation) => {
      const key = pointAggregationKey(observation);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(observation);
    });
    return [...groups.entries()].map(([key, group]) => {
      const representative = group[group.length - 1] || {};
      const valid = group.filter((observation) => observation.valid !== false && typeof observation.actualDetected === 'boolean');
      const triggeredCount = valid.filter((observation) => observation.actualDetected).length;
      const notTriggeredCount = valid.length - triggeredCount;
      const invalidCount = group.length - valid.length;
      const majority = !valid.length ? 'INVALID'
        : triggeredCount > notTriggeredCount ? 'TRIGGERED'
          : notTriggeredCount > triggeredCount ? 'NOT_TRIGGERED' : 'TIE';
      const expected = typeof representative.expectedDetected === 'boolean' ? representative.expectedDetected : null;
      const outcome = majority === 'INVALID' ? 'INVALID' : majority === 'TIE' ? 'MIXED'
        : expected === null ? 'UNASSESSED'
          : classify(expected, majority === 'TRIGGERED', true);
      const latencies = valid.filter((observation) => observation.actualDetected && Number.isFinite(Number(observation.detectionLatencyMs)))
        .map((observation) => Number(observation.detectionLatencyMs)).sort((a, b) => a - b);
      const medianLatencyMs = latencies.length ? (latencies.length % 2
        ? latencies[Math.floor(latencies.length / 2)]
        : (latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2) : null;
      const planned = Math.max(1, Math.floor(finite(cyclesPlanned, 1)));
      return {
        key,
        runId: representative.runId,
        testId: representative.testId,
        pointId: representative.pointId,
        x: finite(representative.x), y: finite(representative.y), z: finite(representative.z, 0),
        distanceMm: finite(representative.distanceMm),
        expectedDetected: expected,
        observations: group.length,
        cyclesPlanned: planned,
        validCount: valid.length,
        invalidCount,
        triggeredCount,
        notTriggeredCount,
        triggerRate: valid.length ? triggeredCount / valid.length : null,
        majority,
        outcome,
        complete: valid.length >= planned,
        medianLatencyMs,
      };
    });
  }

  /** Generates deterministic, evenly distributed formal-test points and an efficient traversal order. */
  function generateRadialPoints(options) {
    const count = Math.max(1, Math.floor(finite(options.count, 100)));
    const geometry = options.geometry || {};
    if (usesDualSystemBands(geometry)) return generateSystemBandPoints(options);
    const sensors = activationSensors(geometry);
    const radius = Math.max(...sensors.map((sensor) => sensor.radiusMm));
    const guard = Math.max(0, finite(geometry.guardBandMm, 10));
    const inside = options.zone === 'inside';
    const innerDepth = inside ? 0 : radius + guard;
    const outerDepth = inside ? radius : Math.max(radius + guard, finite(options.outerRadiusMm, radius * 1.5));
    if (outerDepth <= innerDepth) return [];
    const bounds = options.bounds || {};
    const centerX = finite(geometry.centerX, 0);
    const centerY = finite(geometry.centerY, 0);
    const outerAdjustment = inside ? 0 : outerDepth-radius;
    const domainBoundary = activationZoneBoundaries(geometry, outerAdjustment, 48).flat();
    const activationBoundaries = inside ? [] : activationZoneBoundaries(geometry, 0, 96);
    const minDomainX = Math.min(...domainBoundary.map((point) => point.x));
    const maxDomainX = Math.max(...domainBoundary.map((point) => point.x));
    const minDomainY = Math.min(...domainBoundary.map((point) => point.y));
    const maxDomainY = Math.max(...domainBoundary.map((point) => point.y));

    // Rejection-sampled Halton points fill the manual lobe (or the homothetic
    // exterior band between two lobes) uniformly and deterministically.
    const halton = (index, base) => {
      let result = 0;
      let fraction = 1 / base;
      let n = index;
      while (n > 0) {
        result += fraction * (n % base);
        n = Math.floor(n / base);
        fraction /= base;
      }
      return result;
    };
    const sampleTarget = Math.min(20000, Math.max(6000, count * 120));
    const domainSamples = [];
    const maxCandidates = sampleTarget * 50;
    for (let i = 1; i <= maxCandidates && domainSamples.length < sampleTarget; i++) {
      const x = minDomainX + halton(i, 2) * (maxDomainX-minDomainX);
      const y = minDomainY + halton(i, 3) * (maxDomainY-minDomainY);
      const sample = { x, y };
      if (!pointInActivationZone(sample, geometry, outerAdjustment)) continue;
      if (!inside && (pointInActivationZone(sample, geometry)
        || distanceToBoundaries(sample, activationBoundaries) <= guard + 1e-6)) continue;
      if (Number.isFinite(bounds.minX) && x < bounds.minX) continue;
      if (Number.isFinite(bounds.maxX) && x > bounds.maxX) continue;
      if (Number.isFinite(bounds.minY) && y < bounds.minY) continue;
      if (Number.isFinite(bounds.maxY) && y > bounds.maxY) continue;
      if (!pointInAngularZone(sample, geometry, options.angularZoneEnabled, options.angularZone)) continue;
      if (typeof options.isPointAllowed === 'function' && !options.isPointAllowed(sample)) continue;
      domainSamples.push(sample);
    }
    if (domainSamples.length < count) {
      return domainSamples.map((point) => ({
        x: Math.round(point.x * 1000) / 1000,
        y: Math.round(point.y * 1000) / 1000,
        z: finite(options.z, 0),
        holdMs: Math.max(0, finite(options.holdMs, 1000)),
        expectedDetected: inside,
        zone: inside ? 'inside' : 'outside',
      }));
    }

    // Constrained Lloyd relaxation: divide a dense deterministic model of the
    // valid area into one cell per requested point, then move each point to the
    // valid sample nearest its cell centroid. Exact count is preserved, while
    // nearest-neighbor spacing converges toward the regular hexagonal pattern
    // expected from equal-area cells. Selecting an in-domain medoid keeps the
    // non-convex exterior lobe band, guard band, and travel limits.
    let relaxed = domainSamples.slice(0, count).map((point) => ({ ...point }));
    const iterationLimit = count > 400 ? 25 : inside ? 40 : 70;
    for (let iteration = 0; iteration < iterationLimit; iteration++) {
      const sumX = Array(count).fill(0);
      const sumY = Array(count).fill(0);
      const clusters = Array.from({ length: count }, () => []);
      domainSamples.forEach((sample) => {
        let nearest = 0;
        let nearestDistance = Infinity;
        for (let index = 0; index < count; index++) {
          const dx = sample.x-relaxed[index].x;
          const dy = sample.y-relaxed[index].y;
          const distance = dx*dx+dy*dy;
          if (distance < nearestDistance) { nearestDistance = distance; nearest = index; }
        }
        sumX[nearest] += sample.x;
        sumY[nearest] += sample.y;
        clusters[nearest].push(sample);
      });

      let largestMove = 0;
      relaxed = relaxed.map((point, index) => {
        const cluster = clusters[index];
        if (!cluster.length) return point;
        const centroidX = sumX[index]/cluster.length;
        const centroidY = sumY[index]/cluster.length;
        let medoid = cluster[0];
        let medoidDistance = Infinity;
        cluster.forEach((sample) => {
          const dx = sample.x-centroidX;
          const dy = sample.y-centroidY;
          const distance = dx*dx+dy*dy;
          if (distance < medoidDistance) { medoidDistance = distance; medoid = sample; }
        });
        largestMove = Math.max(largestMove, Math.hypot(medoid.x-point.x,medoid.y-point.y));
        return { ...medoid };
      });
      if (largestMove < 0.01) break;
    }

    let candidates = relaxed.map((point) => ({
      x: Math.round(point.x * 1000) / 1000,
      y: Math.round(point.y * 1000) / 1000,
      z: finite(options.z, 0),
      holdMs: Math.max(0, finite(options.holdMs, 1000)),
      expectedDetected: inside,
      zone: inside ? 'inside' : 'outside',
    }));

    // Positive validation must exercise the full required area, not merely
    // permit it mathematically. Reserve a small, evenly distributed subset
    // near the 12-inch lobe boundary; the remaining points retain the relaxed
    // equal-area coverage. A slight inset avoids placing hardware exactly on
    // the floating-point boundary while remaining well inside the old buffer.
    if (inside && options.distribution !== 'even' && candidates.length >= 4) {
      const boundaryCount = Math.min(candidates.length, Math.max(4, Math.round(Math.sqrt(candidates.length))));
      const boundary = activationZoneBoundaries(geometry, -radius * 0.005, Math.max(12, boundaryCount)).flat();
      const targets = Array.from({ length: boundaryCount }, (_, index) => boundary[Math.floor(index * boundary.length / boundaryCount)])
        .filter((point) => (!Number.isFinite(bounds.minX) || point.x >= bounds.minX)
          && (!Number.isFinite(bounds.maxX) || point.x <= bounds.maxX)
          && (!Number.isFinite(bounds.minY) || point.y >= bounds.minY)
          && (!Number.isFinite(bounds.maxY) || point.y <= bounds.maxY)
          && pointInAngularZone(point, geometry, options.angularZoneEnabled, options.angularZone));
      const available = new Set(candidates.map((_, index) => index));
      targets.forEach((target) => {
        let nearestIndex = -1;
        let nearestDistance = Infinity;
        available.forEach((index) => {
          const distance = Math.hypot(candidates[index].x-target.x, candidates[index].y-target.y);
          if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = index; }
        });
        if (nearestIndex < 0) return;
        candidates[nearestIndex] = {
          ...candidates[nearestIndex],
          x: Math.round(target.x * 1000) / 1000,
          y: Math.round(target.y * 1000) / 1000,
        };
        available.delete(nearestIndex);
      });
    }

    // Sampling and traversal are intentionally separate: ordering never
    // changes coverage. The exterior band has separated side regions, so the
    // ordering follows the band instead of cutting through the activation zone.
    if (candidates.length < 2) return candidates;
    if (!inside) {
      const bandThickness = Math.max(1, outerDepth - innerDepth);
      const midArcLength = Math.PI * (outerDepth + innerDepth) / 2;
      const sectorCount = Math.max(2, Math.round(Math.sqrt(candidates.length * midArcLength / bandThickness)));
      const sectors = Array.from({ length: sectorCount }, () => []);
      candidates.forEach((point) => {
        const angle = Math.atan2(centerY - point.y, point.x - centerX); // 0..PI, right to left
        const sector = Math.min(sectorCount - 1, Math.floor(angle / Math.PI * sectorCount));
        sectors[sector].push(point);
      });
      let outerToInner = false;
      return sectors.filter((sector) => sector.length).flatMap((sector) => {
        const ordered = sector.sort((a, b) => {
          const radiusA = Math.hypot(a.x-centerX, a.y-centerY);
          const radiusB = Math.hypot(b.x-centerX, b.y-centerY);
          return outerToInner ? radiusB-radiusA : radiusA-radiusB;
        });
        outerToInner = !outerToInner;
        return ordered;
      });
    }

    // The filled interior is continuous, so horizontal serpentine rows give
    // a predictable scan with short transitions between neighboring rows.
    const rowCount = Math.max(1, Math.round(Math.sqrt(candidates.length / 2)));
    const minY = Math.min(...candidates.map((p) => p.y));
    const maxY = Math.max(...candidates.map((p) => p.y));
    const rowHeight = Math.max(1e-9, (maxY - minY) / rowCount);
    const rows = Array.from({ length: rowCount }, () => []);
    candidates.forEach((point) => {
      const row = Math.min(rowCount - 1, Math.floor((maxY - point.y) / rowHeight));
      rows[row].push(point);
    });
    let reverse = false;
    return rows.filter((row) => row.length).flatMap((row) => {
      const ordered = row.sort((a, b) => reverse ? b.x - a.x : a.x - b.x);
      reverse = !reverse;
      return ordered;
    });
  }

  /** Generates deterministic points in footprint-offset required-trigger or required-no-trigger zones. */
  function generateSystemBandPoints(options) {
    const count = Math.max(1, Math.floor(finite(options.count, 100)));
    const geometry = options.geometry || {};
    const reference = systemReferencePoint(geometry);
    if (!reference) return [];
    const footprint = systemFootprintBounds(geometry);
    const inside = options.zone === 'inside';
    const triggerRadius = requiredTriggerMm(geometry);
    const noTriggerRadius = requiredNoTriggerMm(geometry);
    const innerRadius = inside ? 0 : noTriggerRadius;
    const outerRadius = inside ? triggerRadius
      : Math.max(noTriggerRadius + 1, finite(options.outerRadiusMm, noTriggerRadius * 1.25));
    const bounds = options.bounds || {};
    const samplingBounds = footprint || { minX: reference.x, maxX: reference.x, minY: reference.y, maxY: reference.y };
    if (footprint && PERIMETER_COVERAGE_MODES.includes(String(options.coverageMode))) {
      return generatePerimeterPoints({ ...options, geometry, outerRadiusMm: outerRadius, bounds, keepOutClearanceMm: options.keepOutClearanceMm });
    }
    const halton = (index, base) => {
      let result = 0, fraction = 1 / base, n = index;
      while (n > 0) { result += fraction * (n % base); n = Math.floor(n / base); fraction /= base; }
      return result;
    };
    const points = [];
    const maxCandidates = Math.max(10000, count * 1000);
    for (let index = 1; index <= maxCandidates && points.length < count; index++) {
      const x = samplingBounds.minX-outerRadius
        + halton(index, 2)*(samplingBounds.maxX-samplingBounds.minX+2*outerRadius);
      const y = samplingBounds.minY-outerRadius
        + halton(index, 3)*(samplingBounds.maxY-samplingBounds.minY+2*outerRadius);
      const distance = systemDistanceMm({ x, y }, geometry);
      if (distance === null || distance <= 1e-9) continue;
      if (inside && distance > outerRadius + 1e-9) continue;
      if (!inside && (distance <= innerRadius + 1e-9 || distance > outerRadius + 1e-9)) continue;
      if (Number.isFinite(bounds.minX) && x < bounds.minX) continue;
      if (Number.isFinite(bounds.maxX) && x > bounds.maxX) continue;
      if (Number.isFinite(bounds.minY) && y < bounds.minY) continue;
      if (Number.isFinite(bounds.maxY) && y > bounds.maxY) continue;
      if (!pointInAngularZone({ x, y }, geometry, options.angularZoneEnabled, options.angularZone)) continue;
      if (typeof options.isPointAllowed === 'function' && !options.isPointAllowed({ x, y })) continue;
      points.push({
        x: Math.round(x * 1000) / 1000,
        y: Math.round(y * 1000) / 1000,
        z: finite(options.z, 0),
        holdMs: Math.max(0, finite(options.holdMs, 1000)),
        expectedDetected: inside,
        zone: inside ? 'required-trigger' : 'required-no-trigger',
        coveragePartition: systemCoveragePartition({ x, y }, geometry),
      });
    }
    if (points.length >= 4 && footprint && ['inside', 'outside'].includes(options.zone)
      && options.distribution !== 'even') {
      const boundaryRadius = inside ? triggerRadius * 0.995 : noTriggerRadius + Math.max(0.1, noTriggerRadius * 0.005);
      const boundaryCount = Math.min(points.length, Math.max(4, Math.round(Math.sqrt(points.length))));
      const boundary = offsetRectangleBoundary(footprint, boundaryRadius, Math.max(16, boundaryCount * 2))
        .filter((point) => (!Number.isFinite(bounds.minX) || point.x >= bounds.minX)
          && (!Number.isFinite(bounds.maxX) || point.x <= bounds.maxX)
          && (!Number.isFinite(bounds.minY) || point.y >= bounds.minY)
          && (!Number.isFinite(bounds.maxY) || point.y <= bounds.maxY)
          && pointInAngularZone(point, geometry, options.angularZoneEnabled, options.angularZone)
          && (typeof options.isPointAllowed !== 'function' || options.isPointAllowed(point)));
      for (let index = 0; index < boundaryCount && boundary.length; index++) {
        const source = boundary[Math.floor(index * boundary.length / boundaryCount)];
        points[index] = { ...points[index], x: Math.round(source.x * 1000) / 1000, y: Math.round(source.y * 1000) / 1000 };
      }
    }
    return points;
  }

  /** Generates one combined green/grey/red System Level section plan. */
  function generateSystemValidationPoints(options = {}) {
    const count = Math.max(3, Math.floor(finite(options.count, 15)));
    const geometry = options.geometry || {};
    const footprint = systemFootprintBounds(geometry);
    if (!usesDualSystemBands(geometry) || !footprint) return [];
    const greenCount = Math.max(1, Math.floor(count * 0.4));
    const greyCount = Math.max(1, count - greenCount - Math.max(1, Math.floor(count * 0.4)));
    const redCount = count - greenCount - greyCount;
    const trigger = requiredTriggerMm(geometry);
    const noTrigger = requiredNoTriggerMm(geometry);
    const redOuter = Math.max(noTrigger + 1, finite(options.outerRadiusMm, noTrigger * 1.25));
    const bounds = options.bounds || {};
    const halton = (index, base) => {
      let result = 0, fraction = 1 / base, value = index;
      while (value > 0) { result += fraction * (value % base); value = Math.floor(value / base); fraction /= base; }
      return result;
    };
    const sampleBand = (target, minDistance, maxDistance, zone, expectedDetected, offset) => {
      const points = [];
      for (let index = 1; index <= Math.max(10000, target * 2000) && points.length < target; index += 1) {
        const sample = index + offset;
        const x = footprint.minX-maxDistance + halton(sample, 2)*(footprint.maxX-footprint.minX+2*maxDistance);
        const y = footprint.minY-maxDistance + halton(sample, 3)*(footprint.maxY-footprint.minY+2*maxDistance);
        const point = { x, y };
        const distance = systemDistanceMm(point, geometry);
        if (distance === null || distance <= minDistance + 1e-9 || distance > maxDistance + 1e-9) continue;
        if (Number.isFinite(bounds.minX) && x < bounds.minX) continue;
        if (Number.isFinite(bounds.maxX) && x > bounds.maxX) continue;
        if (Number.isFinite(bounds.minY) && y < bounds.minY) continue;
        if (Number.isFinite(bounds.maxY) && y > bounds.maxY) continue;
        if (!pointInAngularZone(point, geometry, options.angularZoneEnabled !== false, options.angularZone || 'front')) continue;
        if (typeof options.isPointAllowed === 'function' && !options.isPointAllowed(point)) continue;
        points.push({
          x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000,
          z: finite(options.z, 0), holdMs: Math.max(0, finite(options.holdMs, 1000)), zone,
          ...(typeof expectedDetected === 'boolean' ? { expectedDetected } : {}),
          coveragePartition: systemCoveragePartition(point, geometry),
        });
      }
      return points;
    };
    const keepOut = Math.max(0, finite(options.keepOutClearanceMm, 0));
    const bands = [
      sampleBand(greenCount, keepOut, trigger, 'required-trigger', true, 0),
      sampleBand(greyCount, trigger, noTrigger, 'optional', null, 137),
      sampleBand(redCount, noTrigger, redOuter, 'required-no-trigger', false, 277),
    ];
    const points = [];
    for (let index = 0; points.length < count && bands.some((band) => index < band.length); index += 1) {
      bands.forEach((band) => { if (index < band.length) points.push(band[index]); });
    }
    return points.slice(0, count);
  }

  return { SCHEMA_VERSION, GEOMETRY_SEMANTICS, SYSTEM_REQUIRED_TRIGGER_MM, SYSTEM_REQUIRED_NO_TRIGGER_MM, ANGULAR_ZONES, PERIMETER_COVERAGE_MODES, PERIMETER_SIDES, OUTCOME, TEST_DEFINITIONS, MANUAL_LOBE_PROFILE, distanceMm, geometrySemantics, usesDualSystemBands, systemReferencePoint, forwardAngleDeg, headingVector, pointInAngularZone, systemFootprintBounds, distanceToFootprintMm, systemDistanceMm, classifySystemDistance, offsetRectangleBoundary, systemBandBoundaries, systemCoveragePartition, generatePerimeterPoints, manualLobeHalfWidth, pointInManualLobe, manualLobeBoundary, activationSensors, pointInActivationZone, activationZoneBoundaries, distanceToActivationZoneBoundary, classifyZone, classifyZoneForTest, expectedFor, validatePlan, classify, triggeredSensorLabel, createObservation, summarize, effectiveObservations, pointAggregationKey, aggregateByPoint, generateRadialPoints, generateSystemBandPoints, generateSystemValidationPoints };
}));
