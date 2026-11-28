export class StoreError extends Error {
  constructor(message, code, statusCode, context = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
  }
}

export class ConditionFailedError extends StoreError {
  constructor(message, context = {}) {
    super(message, 'PRECONDITION_FAILED', 412, context);
  }
}

export class ConflictError extends StoreError {
  constructor(message, context = {}) {
    super(message, 'CONFLICT', 409, context);
  }
}

export class RetentionBlockedError extends StoreError {
  constructor(message, context = {}) {
    super(message, 'RETENTION_BLOCKED', 403, context);
  }
}

export class VersionNotFoundError extends StoreError {
  constructor(message, context = {}) {
    super(message, 'VERSION_NOT_FOUND', 404, context);
  }
}

export class ObjectDeletedError extends StoreError {
  constructor(message, context = {}) {
    super(message, 'OBJECT_DELETED', 404, context);
  }
}
