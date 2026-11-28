import { StoreError } from './errors.js';
import { VersionedObjectStore } from './store.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toFailure = (error, visibleHistory) => ({
  ok: false,
  statusCode: error instanceof StoreError ? error.statusCode : 500,
  code: error instanceof StoreError ? error.code : 'INTERNAL_ERROR',
  error: error.message,
  context: error instanceof StoreError ? error.context : {},
  illegalOverride: false,
  restoreAction: null,
  visibleHistory,
});

const toSuccess = (result) => ({
  ok: true,
  statusCode: result.statusCode,
  code: 'OK',
  versionId: result.versionId,
  etag: result.etag,
  isDeleteMarker: result.isDeleteMarker,
  illegalOverride: result.illegalOverride === true,
  restoreAction: result.restoreAction,
  bypassedGovernance: result.bypassedGovernance === true,
  conflict: result.conflict === true,
  currentVersionId: result.currentVersionId ?? result.versionId,
  currentIsDeleteMarker:
    result.currentIsDeleteMarker ?? result.isDeleteMarker === true,
  visibleHistory: result.visibleHistory,
});

function runSingle(store, key, operation) {
    const before = store.listVersions(key);
    try {
      let result;
      if (operation.type === 'put') {
        const args = [key, operation.body ?? '', buildWriteOptions(operation)];
        result = operation.legacy
          ? store.legacyPutObject(...args)
          : store.putObject(...args);
      } else if (operation.type === 'delete') {
        result = store.deleteObject(key, buildWriteOptions(operation));
      } else if (operation.type === 'get') {
        result = store.getObject(key, { versionId: operation.versionId });
        return {
          ok: true,
          statusCode: 200,
          code: 'OK',
          versionId: result.versionId,
          etag: result.etag,
          isDeleteMarker: false,
          illegalOverride: false,
          restoreAction: null,
          visibleHistory: before,
        };
      } else {
        throw new TypeError(`未知操作类型: ${operation.type}`);
      }
      return toSuccess(result);
    } catch (error) {
      return toFailure(error, before);
    }
}

function buildWriteOptions(operation) {
  const options = {};
  for (const field of [
    'ifMatch',
    'ifNoneMatch',
    'etag',
    'versionId',
    'retention',
    'bypassGovernanceRetention',
  ]) {
    if (operation[field] !== undefined) options[field] = operation[field];
  }
  return options;
}

async function runConcurrent(store, key, operation) {
  const writes = operation.writes ?? [];
  if (operation.preCreateAllTickets) {
    const tickets = writes.map((write) => ({
      write,
      ticket: store.beginConditionalWrite(key),
    }));
    return Promise.all(
      tickets.map(async ({ write, ticket }) => {
        if (write.delayMs) await sleep(write.delayMs);
        const visibleHistory = store.listVersions(key);
        try {
          const result = store.commitConditionalWrite(
            ticket.ticketId,
            write.body ?? '',
            buildWriteOptions(write),
          );
          return toSuccess(result);
        } catch (error) {
          return toFailure(error, visibleHistory);
        }
      }),
    );
  }
  return Promise.all(
    writes.map(async (write) => {
      const ticket = store.beginConditionalWrite(key);
      if (write.delayMs) await sleep(write.delayMs);
      const visibleHistory = store.listVersions(key);
      try {
        const result = store.commitConditionalWrite(
          ticket.ticketId,
          write.body ?? '',
          buildWriteOptions(write),
        );
        return toSuccess(result);
      } catch (error) {
        return toFailure(error, visibleHistory);
      }
    }),
  );
}

function summarize(results, store, key) {
  const flat = results.flatMap((entry) =>
    Array.isArray(entry.results) ? entry.results : [entry],
  );
  const visibleHistory = store.listVersions(key);
  const current = visibleHistory[visibleHistory.length - 1] ?? null;
  return {
    illegalOverrideCount: flat.filter((entry) => entry.illegalOverride).length,
    restoreActions: flat
      .filter((entry) => entry.restoreAction)
      .map((entry) => entry.restoreAction),
    finalVersion: current
      ? {
          versionId: current.versionId,
          etag: current.etag,
          isDeleteMarker: current.isDeleteMarker,
        }
      : null,
    currentIsDeleteMarker: current ? current.isDeleteMarker : true,
    visibleHistory,
  };
}

export async function runScenario(scenario, { now } = {}) {
  if (!scenario || !scenario.key) {
    throw new TypeError('scenario.key 为必填项');
  }
  const store = new VersionedObjectStore({ now });
  const key = scenario.key;
  store.seed(key, scenario.versions ?? []);
  const results = [];
  for (const operation of scenario.operations ?? []) {
    const operationKey = operation.key ?? key;
    if (operationKey !== key) {
      throw new TypeError(`操作 key ${operationKey} 与场景 key ${key} 不一致`);
    }
    if (operation.type === 'concurrentPut') {
      const concurrentResults = await runConcurrent(store, key, operation);
      results.push({
        id: operation.id ?? `op-${results.length + 1}`,
        type: operation.type,
        results: concurrentResults,
      });
    } else {
      results.push({
        id: operation.id ?? `op-${results.length + 1}`,
        type: operation.type,
        ...runSingle(store, key, operation),
      });
    }
  }
  return {
    key,
    retention: scenario.retention ?? null,
    results,
    ...summarize(results, store, key),
  };
}
