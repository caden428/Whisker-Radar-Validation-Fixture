'use strict';

const assert = require('assert');
const { RunController } = require('../run-controller');
const { CommandArbiter } = require('../command-arbiter');
const { FakeFixtureAdapter } = require('../fixture-adapters');

function memoryStore(initial = null) {
  let value = initial;
  return {
    load: () => value,
    save: (next) => { value = JSON.parse(JSON.stringify(next)); },
    clear: () => { value = null; },
    value: () => value,
  };
}

(async () => {
  const store = memoryStore();
  const changes = [];
  const controller = new RunController(store, (state) => changes.push(state));
  controller.begin({ runId: 'run-1', testId: 'system' });
  controller.transition('home');
  controller.transition('move', { positionIndex: 1, totalPositions: 3 });
  assert.strictEqual(controller.snapshot().phase, 'move');
  assert.strictEqual(store.value().progress.positionIndex, 1);
  controller.requestAbort('operator stop');
  assert.strictEqual(controller.shouldAbort(), true);
  assert.throws(() => controller.transition('trigger'), /cancellation requested|operator stop/);
  controller.finish('aborted', 'operator stop');
  assert.strictEqual(store.value(), null, 'terminal runs must clear active recovery state');
  assert.ok(changes.length >= 4);

  const recoveredStore = memoryStore({ runId: 'old', status: 'active', phase: 'move', updatedAt: 'earlier' });
  const recovered = new RunController(recoveredStore);
  assert.strictEqual(recovered.snapshot().status, 'recovery_required');
  recovered.resolveRecovery('acknowledged');
  assert.strictEqual(recoveredStore.value(), null);

  let releaseMove;
  const moveGate = new Promise((resolve) => { releaseMove = resolve; });
  const fixture = new FakeFixtureAdapter({ move: async () => { await moveGate; return { success: true }; } });
  const arbiter = new CommandArbiter();
  const first = arbiter.run(() => fixture.command('move', { x: 1 }));
  await Promise.resolve();
  const queued = arbiter.run(() => fixture.command('move', { x: 2 }));
  const emergency = await arbiter.emergency(() => fixture.estop());
  assert.strictEqual(emergency.success, true);
  assert.strictEqual(fixture.commands[0].name, 'move');
  assert.strictEqual(fixture.commands[1].name, 'estop', 'E-stop must bypass the ordinary command queue');
  releaseMove();
  assert.strictEqual((await first).success, true);
  const cancelled = await queued;
  assert.strictEqual(cancelled.code, 'ERR_ESTOP', 'commands queued before E-stop must not execute afterward');

  console.log('run controller and fixture adapter tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
