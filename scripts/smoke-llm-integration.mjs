#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, 'tests/fixtures/llm-integration');
const cli = path.join(root, 'dist/cli.js');

function fail(message) {
  console.error(`smoke-llm-integration: ${message}`);
  process.exit(1);
}

if (!existsSync(cli)) {
  fail('dist/cli.js not found — run npm run build first');
}

if (process.env.R3_DOCTOR_LLM_INTEGRATION !== '1') {
  fail('set R3_DOCTOR_LLM_INTEGRATION=1 to run the billable codex-acp smoke test');
}

if (
  process.env.GITHUB_ACTIONS === 'true'
  && !process.env.OPENAI_API_KEY
  && !process.env.CODEX_API_KEY
) {
  fail('OPENAI_API_KEY or CODEX_API_KEY is required for codex provider auth in CI');
}

const inspect = spawnSync(process.execPath, [cli, 'llm', 'inspect', '--provider', 'codex'], {
  cwd: root,
  encoding: 'utf8',
});
const inspectOutput = `${inspect.stdout ?? ''}${inspect.stderr ?? ''}`;
if (inspect.status !== 0) {
  process.stderr.write(inspectOutput);
  fail(`llm inspect failed with exit code ${inspect.status ?? 'unknown'}`);
}
if (!inspectOutput.includes('status=available')) {
  process.stderr.write(inspectOutput);
  fail('codex provider is not available (install @agentclientprotocol/codex-acp and authenticate)');
}

const scan = spawnSync(process.execPath, [
  cli,
  'scan',
  fixture,
  '--format',
  'json',
  '--llm-provider',
  'codex',
  '--llm-model',
  'gpt-5-mini',
  '--llm-send-scope',
  'all',
  '--llm-max-files',
  '5',
], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
  timeout: 240_000,
});
if (scan.status !== 0) {
  process.stderr.write(scan.stderr ?? '');
  fail(`scan failed with exit code ${scan.status ?? 'unknown'}`);
}

let report;
try {
  report = JSON.parse(scan.stdout);
} catch (error) {
  fail(`scan did not emit valid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const axis = report.axes?.find((entry) => entry.axisId === 'semantic-ambiguity');
if (!axis || axis.unevaluated !== false) {
  console.error(JSON.stringify({
    semanticProviderStatus: report.metadata?.semanticProviderStatus,
    semanticProviderReason: report.metadata?.semanticProviderReason,
    axisUnevaluated: axis?.unevaluated,
  }, null, 2));
  fail('semantic-ambiguity axis was not evaluated');
}

if (!Array.isArray(report.semanticFindings) || report.semanticFindings.length < 1) {
  fail('expected at least one semantic finding from codex-acp');
}

console.log(JSON.stringify({
  ok: true,
  semanticProviderStatus: report.metadata.semanticProviderStatus,
  semanticFindingsCount: report.semanticFindings.length,
  axisScore: axis.score,
  llmProvider: report.metadata.llmProvider,
}, null, 2));
