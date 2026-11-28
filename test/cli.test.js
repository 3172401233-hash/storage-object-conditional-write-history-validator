import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const scenarioPath = fileURLToPath(
  new URL('../examples/delete-marker-reuse.json', import.meta.url),
);

test('CLI 输出 JSON 报告并暴露非法覆盖与恢复动作', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, scenarioPath]);
  const report = JSON.parse(stdout);
  assert.equal(report.key, 'documents/report.txt');
  const rejected = report.results.find((entry) => entry.id === 'correct-if-match-on-delete-marker');
  assert.equal(rejected.statusCode, 412);
  const legacy = report.results.find((entry) => entry.id === 'legacy-if-match-restores-marker');
  assert.equal(legacy.illegalOverride, true);
  assert.equal(legacy.restoreAction.type, 'delete-marker-restored');
});
