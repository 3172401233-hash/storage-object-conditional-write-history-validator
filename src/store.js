import crypto from 'node:crypto';
import {
  ConditionFailedError,
  ConflictError,
  ObjectDeletedError,
  RetentionBlockedError,
  VersionNotFoundError,
} from './errors.js';

export const computeEtag = (body) =>
  `"${crypto.createHash('md5').update(body).digest('hex')}"`;

const normalizeEtagList = (value) => {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item));
};

const normalizeRetention = (retention) => {
  if (!retention) return null;
  const mode = retention.mode || 'GOVERNANCE';
  if (mode !== 'GOVERNANCE' && mode !== 'COMPLIANCE') {
    throw new TypeError(`未知保留模式: ${mode}`);
  }
  const retainUntil =
    retention.retainUntil instanceof Date
      ? retention.retainUntil
      : new Date(retention.retainUntil);
  if (Number.isNaN(retainUntil.getTime())) {
    throw new TypeError('retainUntil 必须是合法日期');
  }
  return { mode, retainUntil };
};

export class VersionedObjectStore {
  #data = new Map();
  #tickets = new Map();
  #seq = 0;

  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
  }

  #newVersionId() {
    this.#seq += 1;
    return `v${this.#seq}`;
  }

  seed(key, entries = []) {
    const versions = entries.map((entry, index) => {
      const isDeleteMarker = Boolean(entry.isDeleteMarker);
      return {
        key,
        versionId:
          entry.versionId ?? (isDeleteMarker ? `d${index + 1}` : `seed-${index + 1}`),
        body: entry.body ?? null,
        etag:
          entry.etag ??
          (isDeleteMarker ? null : computeEtag(String(entry.body ?? ''))),
        isDeleteMarker,
        retention: normalizeRetention(entry.retention),
        createdAt: entry.createdAt ?? this.now(),
      };
    });
    this.#data.set(key, versions);
    const maxNumericId = versions.reduce((max, version) => {
      const match = /^v(\d+)$/.exec(version.versionId);
      return match ? Math.max(max, Number(match[1])) : max;
    }, this.#seq);
    this.#seq = maxNumericId;
    return this.listVersions(key);
  }

  listVersions(key) {
    const versions = this.#data.get(key) ?? [];
    const currentIndex = versions.length - 1;
    return versions.map((version, index) => ({
      key: version.key,
      versionId: version.versionId,
      etag: version.etag,
      isDeleteMarker: version.isDeleteMarker,
      isCurrent: index === currentIndex,
      hasBody: version.body !== null,
      retention: version.retention
        ? {
            mode: version.retention.mode,
            retainUntil: version.retention.retainUntil.toISOString(),
          }
        : null,
      createdAt: new Date(version.createdAt).toISOString(),
    }));
  }

  getObject(key, { versionId } = {}) {
    const versions = this.#data.get(key) ?? [];
    if (versions.length === 0) {
      throw new VersionNotFoundError(`对象不存在: ${key}`, { key });
    }
    const index = versionId
      ? versions.findIndex((version) => version.versionId === versionId)
      : versions.length - 1;
    if (index < 0) {
      throw new VersionNotFoundError(`版本不存在: ${key}@${versionId}`, {
        key,
        versionId,
      });
    }
    const version = versions[index];
    if (version.isDeleteMarker) {
      throw new ObjectDeletedError(
        `读取到删除标记: ${key}@${version.versionId}`,
        {
          key,
          versionId: version.versionId,
          isDeleteMarker: true,
        },
      );
    }
    return {
      key,
      versionId: version.versionId,
      etag: version.etag,
      body: version.body,
      isCurrent: index === versions.length - 1,
      retention: version.retention
        ? {
            mode: version.retention.mode,
            retainUntil: version.retention.retainUntil.toISOString(),
          }
        : null,
      createdAt: new Date(version.createdAt).toISOString(),
    };
  }

  #evaluateWriteConditions(versions, { ifMatch, ifNoneMatch }) {
    const current = versions[versions.length - 1];
    const matchList = normalizeEtagList(ifMatch);
    if (matchList.length > 0) {
      if (!current || current.isDeleteMarker || !matchList.includes(current.etag)) {
        throw new ConditionFailedError('If-Match 条件不满足：当前版本 ETag 不匹配或为删除标记', {
          header: 'If-Match',
          expected: matchList,
          currentVersionId: current ? current.versionId : null,
          currentEtag: current && !current.isDeleteMarker ? current.etag : null,
          currentIsDeleteMarker: current ? current.isDeleteMarker : true,
        });
      }
    }
    const noneMatchList = normalizeEtagList(ifNoneMatch);
    if (noneMatchList.includes('*')) {
      if (current && !current.isDeleteMarker) {
        throw new ConditionFailedError('If-None-Match: * 条件不满足：对象已存在', {
          header: 'If-None-Match',
          expected: ['*'],
          currentVersionId: current.versionId,
          currentEtag: current.etag,
        });
      }
    } else if (noneMatchList.length > 0 && current && !current.isDeleteMarker) {
      if (noneMatchList.includes(current.etag)) {
        throw new ConditionFailedError('If-None-Match 条件不满足：ETag 已存在', {
          header: 'If-None-Match',
          expected: noneMatchList,
          currentVersionId: current.versionId,
          currentEtag: current.etag,
        });
      }
    }
  }

  #assertRetention(version, { bypassGovernanceRetention }) {
    if (!version || version.isDeleteMarker || !version.retention) return;
    if (this.now() < version.retention.retainUntil.getTime()) {
      if (version.retention.mode === 'COMPLIANCE' || !bypassGovernanceRetention) {
        throw new RetentionBlockedError(
          `对象仍处于 ${version.retention.mode} 保留期内，禁止覆盖: ${version.versionId}`,
          {
            versionId: version.versionId,
            mode: version.retention.mode,
            retainUntil: version.retention.retainUntil.toISOString(),
          },
        );
      }
    }
  }

  #buildVersion(key, body, options) {
    const isDeleteMarker = Boolean(options.isDeleteMarker);
    const etag =
      options.etag !== undefined
        ? options.etag
        : isDeleteMarker
          ? null
          : computeEtag(String(body ?? ''));
    return {
      key,
      versionId: options.versionId || this.#newVersionId(),
      body: isDeleteMarker ? null : body ?? '',
      etag: isDeleteMarker ? null : etag,
      isDeleteMarker,
      retention: normalizeRetention(options.retention),
      createdAt: this.now(),
    };
  }

  #snapshot(key, versions) {
    this.#data.set(key, versions);
    return this.listVersions(key);
  }

  putObject(key, body, options = {}) {
    const versions = (this.#data.get(key) ?? []).map((version) => ({ ...version }));
    this.#evaluateWriteConditions(versions, options);
    this.#assertRetention(versions[versions.length - 1], options);
    return this.#appendPutVersion(key, body, options, versions);
  }

  #appendPutVersion(key, body, options, versions) {
    const version = this.#buildVersion(key, body, options);
    versions.push(version);
    const visibleHistory = this.#snapshot(key, versions);
    const current = versions[versions.length - 1];
    const previous = versions[versions.length - 2];
    return {
      key,
      versionId: current.versionId,
      etag: current.etag,
      isDeleteMarker: false,
      statusCode: 200,
      illegalOverride: false,
      restoreAction:
        previous && previous.isDeleteMarker
          ? {
              type: 'recreated-after-delete-marker',
              deleteMarkerVersionId: previous.versionId,
              newVersionId: current.versionId,
            }
          : null,
      bypassedGovernance:
        previous &&
        previous.retention &&
        this.now() < previous.retention.retainUntil.getTime() &&
        previous.retention.mode === 'GOVERNANCE' &&
        Boolean(options.bypassGovernanceRetention),
      visibleHistory,
    };
  }

  deleteObject(key, options = {}) {
    const versions = (this.#data.get(key) ?? []).map((version) => ({ ...version }));
    this.#evaluateWriteConditions(versions, options);
    this.#assertRetention(versions[versions.length - 1], options);
    const marker = this.#buildVersion(key, null, { ...options, isDeleteMarker: true });
    versions.push(marker);
    const visibleHistory = this.#snapshot(key, versions);
    return {
      key,
      versionId: marker.versionId,
      etag: null,
      isDeleteMarker: true,
      statusCode: 204,
      illegalOverride: false,
      restoreAction: null,
      visibleHistory,
    };
  }

  legacyPutObject(key, body, options = {}) {
    const versions = (this.#data.get(key) ?? []).map((version) => ({ ...version }));
    const matchList = normalizeEtagList(options.ifMatch);
    let matchedIndex = -1;
    if (matchList.length > 0) {
      matchedIndex = versions.findIndex(
        (version) => version.etag !== null && matchList.includes(version.etag),
      );
      if (matchedIndex < 0) {
        throw new ConditionFailedError('If-Match 条件不满足：历史中找不到该 ETag', {
          header: 'If-Match',
          expected: matchList,
        });
      }
    }
    const illegalOverride =
      matchedIndex >= 0 && matchedIndex !== versions.length - 1;
    this.#evaluateWriteConditions(
      versions,
      { ifMatch: undefined, ifNoneMatch: options.ifNoneMatch },
    );
    this.#assertRetention(versions[versions.length - 1], options);
    const version = this.#buildVersion(key, body, options);
    const insertIndex = matchedIndex >= 0 ? matchedIndex + 1 : versions.length;
    versions.splice(insertIndex, 0, version);
    const visibleHistory = this.#snapshot(key, versions);
    const currentIndex = versions.length - 1;
    const current = versions[currentIndex];
    const restoredMarker = versions
      .slice(insertIndex + 1)
      .find((item) => item.isDeleteMarker);
    return {
      key,
      versionId: version.versionId,
      etag: version.etag,
      isDeleteMarker: false,
      statusCode: 200,
      legacy: true,
      illegalOverride,
      restoreAction: restoredMarker
        ? {
            type: 'delete-marker-restored',
            deleteMarkerVersionId: restoredMarker.versionId,
            insertedVersionId: version.versionId,
            currentVersionId: current.versionId,
          }
        : null,
      currentVersionId: current.versionId,
      currentIsDeleteMarker: current.isDeleteMarker,
      visibleHistory,
    };
  }

  beginConditionalWrite(key) {
    const versions = this.#data.get(key) ?? [];
    const ticketId = crypto.randomUUID();
    this.#tickets.set(ticketId, {
      key,
      expectedHeadVersionId: versions.length ? versions[versions.length - 1].versionId : null,
      committed: false,
    });
    return {
      ticketId,
      key,
      expectedHeadVersionId:
        versions.length ? versions[versions.length - 1].versionId : null,
    };
  }

  commitConditionalWrite(ticketId, body, options = {}) {
    const ticket = this.#tickets.get(ticketId);
    if (!ticket) throw new ConflictError('条件写票据不存在或已失效', { ticketId });
    if (ticket.committed) throw new ConflictError('条件写票据已提交', { ticketId });
    const versions = this.#data.get(ticket.key) ?? [];
    const headVersionId = versions.length
      ? versions[versions.length - 1].versionId
      : null;
    if (headVersionId !== ticket.expectedHeadVersionId) {
      ticket.committed = true;
      throw new ConflictError('条件写竞争失败：头版本已被其他写操作改变', {
        key: ticket.key,
        expectedHeadVersionId: ticket.expectedHeadVersionId,
        actualHeadVersionId: headVersionId,
      });
    }
    const writableVersions = versions.map((item) => ({ ...item }));
    this.#assertRetention(writableVersions[writableVersions.length - 1], options);
    const result = this.#appendPutVersion(ticket.key, body, options, writableVersions);
    ticket.committed = true;
    return { ...result, ticketId, conflict: false };
  }
}
