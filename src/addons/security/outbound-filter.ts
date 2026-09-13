import { createHash } from 'node:crypto';
import path from 'node:path';

import type { SecuritySnippet } from './types.js';

export const OUTBOUND_FILTER_VERSION = '1.0.0';

export const REDACTED_VALUE = '[REDACTED]';
const REDACTED_KEY_LINE = '[REDACTED PRIVATE KEY]';

const GENERATED_SEGMENTS = new Set(['dist', 'build', 'coverage', 'node_modules', 'vendor', 'generated', '__generated__', '.next']);
const GENERATED_NAME = /(?:\.d\.[cm]?ts|\.min\.[cm]?js|\.bundle\.[cm]?js|\.map)$/iu;
const SECRET_FILE_NAMES = [
  /^\.env(?:\..+)?$/u,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/iu,
];
const CREDENTIAL_NAME = /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/iu;

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu;
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/gu,
  /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
];
const SECRET_NAME = /password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential/giu;

export type OutboundFilterResult = {
  snippet: SecuritySnippet | null;
  reasons: string[];
  /** Absolute source line numbers whose text was changed by masking. */
  redactedLines: number[];
};

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Returns why a path must never be sent to a provider, or null. */
export function securityPathExclusionReason(relativePath: string): string | null {
  if (
    relativePath.length === 0 ||
    /[\u0000-\u001f\\]/u.test(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    /^[A-Za-z]:/u.test(relativePath)
  ) {
    return 'unsafe-path';
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return 'unsafe-path';
  const name = segments.at(-1) ?? '';
  if (SECRET_FILE_NAMES.some((pattern) => pattern.test(name))) return 'secret-file';
  if (CREDENTIAL_NAME.test(name)) return 'credential-file';
  if (segments.slice(0, -1).some((segment) => GENERATED_SEGMENTS.has(segment)) || GENERATED_NAME.test(name)) {
    return 'generated-file';
  }
  return null;
}

function isSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t';
}

/** Masks string literals assigned to secret-like names. Scans linearly so long lines stay bounded. */
function maskSecretAssignments(line: string): string {
  SECRET_NAME.lastIndex = 0;
  let masked = '';
  let cursor = 0;
  for (let match = SECRET_NAME.exec(line); match; match = SECRET_NAME.exec(line)) {
    let index = match.index + match[0].length;
    while (index < line.length && /[\w$]/u.test(line[index] ?? '')) index += 1;
    if (line[index] === '"' || line[index] === "'") index += 1;
    while (isSpace(line[index])) index += 1;
    const operator = line[index];
    if ((operator !== ':' && operator !== '=') || line[index + 1] === '=' || line[index + 1] === '>') continue;
    index += 1;
    while (isSpace(line[index])) index += 1;
    const quote = line[index];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    let close = index + 1;
    while (close < line.length && line[close] !== quote) close += line[close] === '\\' ? 2 : 1;
    if (close >= line.length || close === index + 1) continue;
    masked += `${line.slice(cursor, index + 1)}${REDACTED_VALUE}`;
    cursor = close;
    SECRET_NAME.lastIndex = close + 1;
  }
  return masked + line.slice(cursor);
}

function maskSecrets(content: string): string {
  const withoutKeys = content.replace(PRIVATE_KEY_BLOCK, (block) =>
    block.split('\n').map(() => REDACTED_KEY_LINE).join('\n'),
  );
  return withoutKeys
    .split('\n')
    .map((line) => TOKEN_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED_VALUE), maskSecretAssignments(line)))
    .join('\n');
}

/**
 * Applies the outbound policy to one snippet: forbidden paths and binary content are dropped, detectable
 * secret values are masked line-for-line so original line numbers stay valid, and the returned snippet's
 * hash describes the text that will actually be sent. Reasons never include the detected values.
 */
export function filterSecuritySnippet(snippet: SecuritySnippet): OutboundFilterResult {
  const excluded = securityPathExclusionReason(snippet.path);
  if (excluded) return { snippet: null, reasons: [excluded], redactedLines: [] };
  if (snippet.content.includes('\u0000')) return { snippet: null, reasons: ['binary-content'], redactedLines: [] };

  const masked = maskSecrets(snippet.content);
  if (masked === snippet.content) return { snippet, reasons: [], redactedLines: [] };

  const original = snippet.content.split('\n');
  const lines = masked.split('\n');
  const redactedLines = lines.flatMap((line, index) => (line === original[index] ? [] : [snippet.startLine + index]));
  if (lines.every((line) => line.trim() === '' || line.trim() === REDACTED_KEY_LINE)) {
    return { snippet: null, reasons: ['masked-unanalyzable'], redactedLines };
  }
  return {
    snippet: { ...snippet, content: masked, contentHash: sha256(masked), redactedLines },
    reasons: ['secret-masked'],
    redactedLines,
  };
}
