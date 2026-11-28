import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConditionFailedError,
  ConflictError,
  ObjectDeletedError,
  RetentionBlockedError,
} from '../src/errors.js';
import { VersionedObjectStore, computeEtag } from '../src/store.js';

const fixedNow = () => Date.parse('2026-11-28T03:00:00.000Z');

test('computeEtag 生成带双引号的 MD5 ETag', () => {
  assert.match(computeEtag('alpha'), /^"[0-9a-f]{32}"$/);
  assert.equal(computeEtag('alpha'), computeEtag('alpha'));
  assert.notEqual(computeEtag('alpha'), computeEtag('beta'));
});

test('If-Match 匹配当前版本时写入并追加新版本', () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [{ versionId: 'v1', body: 'alpha', etag: '"e1"' }]);
  const result = store.putObject('k', 'beta', { ifMatch: '"e1"', etag: '"e2"' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.illegalOverride, false);
  assert.equal(result.visibleHistory.at(-1).versionId, result.versionId);
  assert.equal(result.visibleHistory.at(-1).isCurrent, true);
});

test('旧 ETag 不再匹配当前版本时返回 412，历史不变', () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [
    { versionId: 'v1', body: 'alpha', etag: '"old"' },
    { versionId: 'v2', body: 'beta', etag: '"new"' },
  ]);
  assert.throws(
    () => store.putObject('k', 'gamma', { ifMatch: '"old"' }),
    ConditionFailedError,
  );
  const history = store.listVersions('k');
  assert.equal(history.length, 2);
  assert.equal(history.at(-1).versionId, 'v2');
});

test('ETag 可在历史中重用，但条件只认当前版本', () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [
    { versionId: 'v1', body: 'alpha', etag: '"shared"' },
    { versionId: 'v2', body: 'beta', etag: '"other"' },
  ]);
  assert.throws(
    () => store.putObject('k', 'delta', { ifMatch: '"shared"' }),
    ConditionFailedError,
  );
  const result = store.putObject('k', 'alpha-again', {
    ifMatch: '"other"',
    etag: '"shared"',
  });
  assert.equal(result.etag, '"shared"');
  assert.equal(store.listVersions('k').filter((v) => v.etag === '"shared"').length, 2);
});

test('当前版本为删除标记时，正确引擎拒绝 If-Match 且不恢复标记', () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [
    { versionId: 'v1', body: 'alpha', etag: '"e1"' },
    { versionId: 'd1', isDeleteMarker: true, etag: '"e1"' },
  ]);
  assert.throws(
    () => store.putObject('k', 'beta', { ifMatch: '"e1"' }),
    ConditionFailedError,
  );
  const history = store.listVersions('k');
  assert.equal(history.at(-1).versionId, 'd1');
  assert.equal(history.at(-1).isDeleteMarker, true);
});

test('If-None-Match 星号允许在删除标记后重建对象并记录恢复动作', () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [
    { versionId: 'v1', body: 'alpha', etag: '"e1"' },
    { versionId: 'd1', isDeleteMarker: true, etag: null },
  ]);
  const result = store.putObject('k', 'beta', {
    ifNoneMatch: '*',
    etag: '"e2"',
  });
  assert.equal(result.restoreAction.type, 'recreated-after-delete-marker');
  assert.equal(result.restoreAction.deleteMarkerVersionId, 'd1');
  assert.equal(store.listVersions('k').at(-1).isDeleteMarker, false);
});

test('读取当前删除标记报 404，但可按版本读取历史对象', () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [
    { versionId: 'v1', body: 'alpha', etag: '"e1"' },
    { versionId: 'd1', isDeleteMarker: true, etag: null },
  ]);
  assert.throws(() => store.getObject('k'), ObjectDeletedError);
  const historical = store.getObject('k', { versionId: 'v1' });
  assert.equal(historical.body, 'alpha');
  assert.equal(historical.isCurrent, false);
});

test('删除操作追加新删除标记，重复删除不会覆盖历史', () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [{ versionId: 'v1', body: 'alpha', etag: '"e1"' }]);
  const first = store.deleteObject('k');
  const second = store.deleteObject('k');
  assert.notEqual(first.versionId, second.versionId);
  assert.equal(store.listVersions('k').length, 3);
});

test('COMPLIANCE 保留期内禁止覆盖，绕过参数也无效', () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [
    {
      versionId: 'v1',
      body: 'alpha',
      etag: '"e1"',
      retention: { mode: 'COMPLIANCE', retainUntil: '2026-11-29T00:00:00.000Z' },
    },
  ]);
  assert.throws(
    () =>
      store.putObject('k', 'beta', {
        ifMatch: '"e1"',
        bypassGovernanceRetention: true,
      }),
    RetentionBlockedError,
  );
});

test('GOVERNANCE 保留期默认阻止，显式绕过后写入并标记 bypassedGovernance', () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [
    {
      versionId: 'v1',
      body: 'alpha',
      etag: '"e1"',
      retention: { mode: 'GOVERNANCE', retainUntil: '2026-11-29T00:00:00.000Z' },
    },
  ]);
  assert.throws(() => store.putObject('k', 'x', { ifMatch: '"e1"' }), RetentionBlockedError);
  const result = store.putObject('k', 'beta', {
    ifMatch: '"e1"',
    bypassGovernanceRetention: true,
    etag: '"e2"',
  });
  assert.equal(result.bypassedGovernance, true);
  assert.equal(store.listVersions('k').at(-1).etag, '"e2"');
});

test('乐观锁并发写：首个提交成功，竞争提交返回 409', async () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [{ versionId: 'v1', body: 'a', etag: '"e1"' }]);
  const ticketA = store.beginConditionalWrite('k');
  const ticketB = store.beginConditionalWrite('k');
  const winner = store.commitConditionalWrite(ticketA.ticketId, 'b', {
    ifMatch: '"e1"',
    etag: '"e2"',
  });
  assert.equal(winner.conflict, false);
  assert.throws(
    () => store.commitConditionalWrite(ticketB.ticketId, 'c'),
    ConflictError,
  );
});

test('遗留引擎：If-Match 命中历史同 ETag 后把旧删除标记恢复为当前版本', () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [
    { versionId: 'v1', body: 'alpha', etag: '"shared"' },
    { versionId: 'd1', isDeleteMarker: true, etag: '"shared"' },
  ]);
  const result = store.legacyPutObject('k', 'gamma', {
    ifMatch: '"shared"',
    etag: '"gamma"',
  });
  assert.equal(result.legacy, true);
  assert.equal(result.illegalOverride, true);
  assert.equal(result.restoreAction.type, 'delete-marker-restored');
  assert.equal(result.restoreAction.deleteMarkerVersionId, 'd1');
  assert.equal(result.currentVersionId, 'd1');
  assert.equal(result.currentIsDeleteMarker, true);
  assert.equal(store.listVersions('k').at(-1).versionId, 'd1');
  assert.equal(store.listVersions('k').at(-1).isDeleteMarker, true);
});

test('遗留引擎：普通旧 ETag 匹配也会在历史中间插入并遮蔽新版本', () => {
  const store = new VersionedObjectStore({ now: fixedNow });
  store.seed('k', [
    { versionId: 'v1', body: 'alpha', etag: '"shared"' },
    { versionId: 'v2', body: 'beta', etag: '"current"' },
  ]);
  const result = store.legacyPutObject('k', 'gamma', {
    ifMatch: '"shared"',
    etag: '"gamma"',
  });
  assert.equal(result.illegalOverride, true);
  assert.equal(store.listVersions('k').at(-1).versionId, 'v2');
  assert.equal(store.listVersions('k').map((v) => v.versionId).join(','), 'v1,v3,v2');
});
