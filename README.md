# storage-object-conditional-write-history-validator

验证版本化对象存储的条件写历史：`If-Match` / `If-None-Match`、删除标记（delete marker）、
ETag 重用、历史版本读取、对象保留策略（retention）以及并发条件写竞争。

## 本地模型声明

**所有对象、版本、删除标记、ETag 和保留策略均为进程内本地内存模型，不访问任何网络、
云服务或真实对象存储，也没有外部依赖。** 数据结构只存在于 `VersionedObjectStore` 实例中，
进程退出后即消失；ETag 使用 Node.js 内置 `crypto` 在本地计算 MD5，或由场景输入显式指定。

## 要复现的缺陷

历史版本中同时存在删除标记和与旧版本相同的 ETag。遗留写入路径在评估 `If-Match` 时
只在整条历史中扫描 ETag，既不校验匹配项是否为当前版本，也不检查其后是否还有删除标记；
条件检查“通过”后，新版本被插入到历史中间，旧删除标记或旧版本因此被重新恢复成可见的当前版本。

本仓库同时提供两套写入实现用于对照：

- 正确引擎 `putObject`：条件只针对当前版本评估，新版本始终追加到历史尾部。
- 遗留引擎 `legacyPutObject`：复现上述缺陷，输出 `illegalOverride` 与 `restoreAction`。

## 目录结构

- `src/store.js`：本地版本化对象存储、条件检查、保留策略、乐观锁并发原语与遗留引擎。
- `src/errors.js`：带 HTTP 风格状态码的本地错误类型（412/409/403/404）。
- `src/runner.js`：场景运行器，解析输入操作并汇总每次结果与可见历史。
- `src/cli.js`：命令行入口，读取 JSON 场景并打印报告。
- `examples/`：删除标记 ETag 重用、保留策略与并发竞争两个示例场景。
- `test/`：基于内置 `node:test` 的测试，覆盖旧 ETag、删除标记、并发写等。

## 运行环境与命令

开发与验证环境为 Node.js `v24.16.0`，仅使用 Node 内置模块。

```bash
node --test
npm test
node src/cli.js examples/delete-marker-reuse.json
node src/cli.js examples/delete-marker-reuse.json --legacy
node src/cli.js examples/retention-and-concurrency.json
```

`--legacy` 会把场景中未显式声明 `legacy` 的 `put` 操作切换到遗留缺陷引擎；
也可以在单个操作上设置 `"legacy": true` 做同场对照。

## 场景输入字段

顶层字段：

- `key`：对象键，必填。
- `versions`：种子历史，按从旧到新排列；条目可含 `versionId`、`body`、`etag`、
  `isDeleteMarker`、`retention`、`createdAt`。删除标记需设置 `"isDeleteMarker": true`。
- `retention`：场景级备注，实际以版本上的 `retention` 为准。
- `operations`：有序操作列表，支持 `get`、`put`、`delete`、`concurrentPut`。

写操作字段：

- `ifMatch` / `ifNoneMatch`：条件头，可传字符串或字符串数组；`"*"` 表示对象不存在时才写。
- `etag`：显式指定新版本 ETag，用于构造 ETag 重用；缺省时按 `body` 本地计算 MD5。
- `retention`：新版本保留配置，`mode` 为 `GOVERNANCE` 或 `COMPLIANCE`，含 `retainUntil`。
- `bypassGovernanceRetention`：仅对未过期的 `GOVERNANCE` 保留生效，`COMPLIANCE` 不可绕过。
- `legacy`：`put` 专用，`true` 时走遗留缺陷引擎。
- `concurrentPut.writes`：并发写数组；`preCreateAllTickets: true` 会先创建全部乐观锁票据
  再按 `delayMs` 提交，以确定性地复现竞争。

## 输出字段

每次操作输出：

- `ok`、`statusCode`、`code`、`error`：成功或失败结果；常见失败为 412 条件不满足、
  409 并发冲突、403 保留期阻止、404 对象/版本不存在或读到删除标记。
- `illegalOverride`：遗留引擎在历史中间插入、遮蔽当前版本时为 `true`。
- `restoreAction`：恢复动作；`recreated-after-delete-marker` 是合法重建，
  `delete-marker-restored` 是遗留缺陷导致旧删除标记被恢复。
- `visibleHistory`：该操作观察到的完整版本历史，含 `isCurrent`、`isDeleteMarker` 等标记。

场景级汇总输出：

- `illegalOverrideCount`：非法覆盖总次数。
- `restoreActions`：全部恢复动作。
- `finalVersion`：最终当前版本的 `versionId`、`etag`、`isDeleteMarker`。
- `currentIsDeleteMarker`：最终当前版本是否为删除标记。

## 语义要点

- 条件检查只看当前版本：当前是删除标记时，`If-Match` 直接返回 412，不会复活标记。
- ETag 允许在历史中重复出现，但旧 ETag 不能用于覆盖当前版本。
- `get` 读到当前删除标记返回 404；指定历史 `versionId` 仍可读取旧对象。
- `delete` 总是追加新删除标记，不物理删除历史版本。
- 并发写使用乐观锁票据：头版本已变化时提交返回 409，保证只有一个赢家。
