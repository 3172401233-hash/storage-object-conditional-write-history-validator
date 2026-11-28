#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runScenario } from './runner.js';

const printUsage = () => {
  console.error('用法: node src/cli.js <scenario.json> [--legacy]');
  console.error('  --legacy   将未显式声明 legacy 的 put 操作按遗留缺陷引擎执行');
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }
  const legacyGlobal = args.includes('--legacy');
  const scenarioPath = args.find((arg) => !arg.startsWith('--'));
  if (!scenarioPath) {
    printUsage();
    process.exit(1);
  }
  const raw = await readFile(resolve(process.cwd(), scenarioPath), 'utf8');
  const scenario = JSON.parse(raw);
  if (legacyGlobal) {
    scenario.operations = (scenario.operations ?? []).map((operation) =>
      operation.type === 'put' ? { ...operation, legacy: operation.legacy ?? true } : operation,
    );
  }
  const report = await runScenario(scenario);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        code: error.name ?? 'INTERNAL_ERROR',
        error: error.message,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
