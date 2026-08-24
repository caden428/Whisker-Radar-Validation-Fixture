# Radar Test Flow Tree

This is the current operator and engineering flow. It separates the question “what should I run?” from “how is the fixture configured?”

```text
START
├─ Connect fixture
│  ├─ Moonraker/Klipper ready? ── no → show connection/readiness blocker
│  └─ yes
├─ Choose operating path
│  ├─ Quick Run (single test)
│  │  ├─ Choose test mode
│  │  │  ├─ Test 10.1 / Inside Detection (scored)
│  │  │  ├─ Test 10.2 / Outside Boundary (scored)
│  │  │  ├─ Characterization (raw trigger data; no pass/fail claim)
│  │  │  ├─ Radar Pair Interference (raw pair data)
│  │  │  ├─ Custom Per-Point Validation (scored; explicit point expectations)
│  │  │  └─ Unscored Sequence (raw sequence execution)
│  │  ├─ Select or generate plan
│  │  │  ├─ Automatic formal plan for 10.1/10.2
│  │  │  ├─ Characterization grid / angular-zone filter
│  │  │  ├─ Existing saved sequence
│  │  │  ├─ Engineering Plan Generator (line/raster)
│  │  │  └─ CSV import or hand-edited positions
│  │  ├─ Configure test inputs
│  │  │  ├─ DUT identity and cycle count
│  │  │  ├─ Single/dual/pair sensor layout
│  │  │  ├─ In-field DUT location and no-go footprint
│  │  │  ├─ System Level Bounds (dual-system green/grey/red barriers)
│  │  │  └─ Radar settings and verification
│  │  ├─ Preflight gate
│  │  │  ├─ Fixture ready
│  │  │  ├─ Radar settings verified
│  │  │  ├─ Points exist and match the selected mode
│  │  │  ├─ Points stay within travel and outside the DUT
│  │  │  ├─ Collision-free route exists for every point
│  │  │  └─ CSV logging enabled for scored tests
│  │  └─ RUN TEST
│  │     ├─ Home Y, then X
│  │     ├─ Move through safe route
│  │     ├─ Wait for LOW baseline
│  │     ├─ Spin reflector and sample radar
│  │     ├─ Record observation and repeat cycles
│  │     ├─ Classify / summarize
│  │     └─ Save observations.csv, report.html, and campaign result
│  │
│  └─ Campaign (repeatable qualification)
│     ├─ Define campaign identity and DUT
│     ├─ Select test mode, sensor layout, DUT location, bounds, zones
│     ├─ Select gains/thresholds and repeats/cycles/points
│     ├─ Review generated workload
│     ├─ Create campaign
│     ├─ Prepare next condition (apply + verify settings)
│     ├─ Run normal guarded test flow
│     ├─ Record local result and advance condition
│     ├─ Repeat until no next condition
│     └─ Review or archive campaign
│
└─ Engineering Setup (authoring/configuration, not a test mode)
   ├─ Motion: travel limits, speed, acceleration, offsets
   ├─ Engineering Setup: test identity, geometry, sensor setup, plan editing
   ├─ System Level Bounds: dual-system acceptance barriers
   ├─ Logging & SSH: persistence and service settings
   └─ Error Codes: troubleshooting reference
```

## Why the test plan exists

The plan is the durable contract between the operator and the runner. It defines the ordered X/Y/Z positions, hold time, expected zone/answer where applicable, point count, and the test identity used in reports. The runner should never infer a new physical procedure from a button click; it validates and executes the plan, then records the exact plan with the results.

Engineering Setup exists to author or regenerate that contract. It is needed when hardware, DUT location, system bounds, travel limits, point density, or a custom sequence changes. It should not be required for an ordinary operator who only needs to choose a known test and press Run.

## Operator model

The operator workflow uses one reusable plan concept:

1. **Run a Test** — choose layout, hardware, location, DUT identity, test type, and a compatible Test Plan; review configurable plan values, output naming, and readiness; then press Run Test.
2. **Create or Edit Test Plans** — use the plan-management action beside the selector or the Test Plans settings tab. Built-ins are protected, custom plans are versioned, and the existing point generator, preview, CSV import, and manual editor remain available.
3. **Campaign** — choose the same Test Plan, then add campaign-only conditions and repetition. A campaign orchestrates a plan; it does not define a second kind of procedure.

The existing modes map to Test Plan types: Formal Positive, Formal Negative, Characterization, Pair Interference, Custom Validation, and Unscored Sequence. The legacy recipe schema remains only as a deterministic migration adapter for existing saved data and historical references.

Any future test type should provide five things: a test-plan schema, a plan generator or importer, an expectation/classification rule, a preflight validator, and a report section. That keeps adding a test type bounded and prevents new controls from bypassing safe routing, persistence, or lifecycle input checks.
