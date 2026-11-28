import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runScenario } from '../src/runner.js';

test('运行场景并汇总 412、最终版本、恢复动作与可见历史', async () => {
  const report = await runScenario({
    key: 'k',
    versions: [
      { versionId: 'v1', body: 'alpha', etag: '"e1"' },
      { versionId: 'd1', isDeleteMarker: true, etag: '"e1"' },
    ],
    operations: [
      { id: 'rejected', type: 'put', body: 'x', ifMatch: '"e1"' },
      { id: 'recreated', type: 'put', body: 'x', ifNoneMatch: '*', etag: '"e2"' },
      {
        id: 'legacy',
        type: 'put',
        body: 'y',
        ifMatch: '"e1"',
        etag: '"e3"',
        legacy: true,
      },
    ],
  });
  assert.equal(report.results[0].ok, false);
  assert.equal(report.results[0].statusCode, 412);
  assert.equal(report.results[1].restoreAction.type, 'recreated-after-delete-marker');
  assert.equal(report.results[2].illegalOverride, true);
  assert.equal(
    report.results[2].restoreAction.type,
    'delete-marker-restored',
  );
  assert.equal(report.illegalOverrideCount, 1);
  assert.equal(report.restoreActions.length, 2);
  assert.equal(report.currentIsDeleteMarker, false);
  assert.equal(report.finalVersion.versionId, 'v2');
  assert.equal(report.finalVersion.isDeleteMarker, false);
  assert.ok(report.visibleHistory.length >= 4);
  assert.ok(
    report.visibleHistory.some(
      (version) => version.isDeleteMarker && version.versionId === 'd1',
    ),
  );
});

test('并发条件写只有一个赢家，其余返回 409', async () => {
  const report = await runScenario({
    key: 'k',
    versions: [
      { versionId: 'v1', body: 'a', etag: '"e1"' },
      { versionId: 'd1', isDeleteMarker: true, etag: null },
    ],
    operations: [
      {
        id: 'race',
        type: 'concurrentPut',
        preCreateAllTickets: true,
        writes: [
          { body: 'w1', ifNoneMatch: '*', etag: '"w1"', delayMs: 0 },
          { body: 'w2', ifNoneMatch: '*', etag: '"w2"', delayMs: 15 },
          { body: 'w3', ifNoneMatch: '*', etag: '"w3"', delayMs: 30 },
        ],
      },
    ],
  });
  const race = report.results[0].results;
  assert.equal(race.filter((entry) => entry.ok).length, 1);
  assert.equal(race.filter((entry) => entry.statusCode === 409).length, 2);
  assert.equal(report.finalVersion.etag, '"w1"');
});

test('保留策略场景：COMPLIANCE 阻断、GOVERNANCE 可绕过', async () => {
  const report = await runScenario(
    {
      key: 'k',
      versions: [
        {
          versionId: 'v1',
          body: 'seed',
          etag: '"e1"',
          retention: {
            mode: 'COMPLIANCE',
            retainUntil: '2026-11-29T00:00:00.000Z',
          },
        },
      ],
      operations: [
        { id: 'blocked', type: 'put', body: 'x', ifMatch: '"e1"' },
      ],
    },
    { now: () => Date.parse('2026-11-28T03:00:00.000Z') },
  );
  assert.equal(report.results[0].statusCode, 403);
  assert.equal(report.results[0].code, 'RETENTION_BLOCKED');
  assert.equal(report.finalVersion.versionId, 'v1');
});
