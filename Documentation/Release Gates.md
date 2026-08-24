# Release gates

Release gates separate software qualification from authorization to operate a physical fixture.

## Simulated gate

Run `npm run release:simulated`. It runs linting, the architecture format baseline, unit tests, and V8 function coverage. Successful evidence is written to `dist/release-gates/simulated.json`. The Electron renderer integration test remains a separate required CI check (`npm run test:renderer`) because nested Electron launches are unreliable on Windows runners.

## Physical gate

The physical gate never drives hardware. It validates a human-approved acceptance record after the simulated gate has passed. Set `RADAR_PHYSICAL_ACCEPTANCE_FILE` to a JSON file and run `npm run release:physical`.

The record must contain non-empty `fixtureId`, `softwareVersion`, `approvedBy`, and ISO-style `approvedAt` strings. It must also set these fields to `true`: `emergencyStopVerified`, `travelLimitsVerified`, `radarReadbackVerified`, and `artifactSetVerified`.

## Diagnostics

The main process writes newline-delimited JSON to Electron's user-data directory as `diagnostics.jsonl`. Records include event, severity, timestamp, current run ID, and—where applicable—a command ID. IPC contract rejections are recorded without logging full command payloads or CSV data.
