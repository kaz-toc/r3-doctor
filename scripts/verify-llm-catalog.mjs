#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'dist/cli.js');
const goldenPath = path.join(root, 'tests/fixtures/llm-catalog.golden.json');

function fail(message) {
  console.error(`verify-llm-catalog: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const probeIndex = argv.indexOf('--probe');
  if (probeIndex !== -1) {
    const providerId = argv[probeIndex + 1];
    const jsonPath = argv[probeIndex + 2];
    if (!providerId || !jsonPath) {
      fail('usage: verify-llm-catalog.mjs --probe <providerId> <jsonPath>');
    }
    return { mode: 'probe', providerId, jsonPath };
  }
  return { mode: 'catalog' };
}

function stripOperatorDefault(report) {
  const { operatorDefault: _ignored, ...rest } = report;
  return rest;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyProbe(providerId, jsonPath) {
  if (!existsSync(jsonPath)) {
    fail(`probe JSON not found: ${jsonPath}`);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    fail(`invalid probe JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const provider = report.providers?.find((entry) => entry.id === providerId);
  if (!provider) {
    fail(`provider not found in probe JSON: ${providerId}`);
  }
  if (provider.inspect?.status !== 'available') {
    console.error(JSON.stringify(provider, null, 2));
    fail(`${providerId} is not available (inspect.status=${provider.inspect?.status ?? 'missing'})`);
  }
  console.log(JSON.stringify({ ok: true, provider: providerId, status: 'available' }, null, 2));
}

function verifyCatalog() {
  if (!existsSync(cli)) {
    fail('dist/cli.js not found — run npm run build first');
  }
  if (!existsSync(goldenPath)) {
    fail(`golden fixture not found: ${goldenPath}`);
  }

  const configHome = mkdtempSync(path.join(os.tmpdir(), 'r3-doctor-catalog-verify-'));
  let result;
  try {
    result = spawnSync(process.execPath, [cli, 'llm', 'list', '--format', 'json'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
    });
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    fail(`llm list failed with exit code ${result.status ?? 'unknown'}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    fail(`llm list did not emit valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (report.schemaVersion !== 1) {
    fail(`unexpected schemaVersion: ${report.schemaVersion}`);
  }

  const providerIds = report.providers?.map((provider) => provider.id) ?? [];
  if (providerIds.join(',') !== 'copilot,cursor,codex,claude') {
    fail(`unexpected provider order: ${providerIds.join(',')}`);
  }

  for (const provider of report.providers ?? []) {
    if (provider.inspect?.status !== 'skipped') {
      fail(`catalog must not spawn ACP probes (provider=${provider.id}, status=${provider.inspect?.status})`);
    }
  }

  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  if (!deepEqual(stripOperatorDefault(report), golden)) {
    fail('llm list catalog JSON does not match tests/fixtures/llm-catalog.golden.json');
  }

  console.log(JSON.stringify({ ok: true, providers: providerIds.length }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
if (args.mode === 'probe') {
  verifyProbe(args.providerId, args.jsonPath);
} else {
  verifyCatalog();
}
