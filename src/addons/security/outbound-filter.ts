import { createHash } from 'node:crypto';
import path from 'node:path';

import ts from 'typescript';

import type { SecuritySnippet } from './types.js';

export const OUTBOUND_FILTER_VERSION = '1.0.1';

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
const SECRET_NAME = /password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential/iu;

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

/** Preserve the text heuristic for inline examples, comments, and partial source that has no AST node. */
function maskInlineSecretAssignments(line: string): string {
  const names = new RegExp(SECRET_NAME, 'giu');
  const isSpace = (character: string | undefined) => character === ' ' || character === '\t';
  let masked = '';
  let cursor = 0;
  for (let match = names.exec(line); match; match = names.exec(line)) {
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
    names.lastIndex = close + 1;
  }
  return masked + line.slice(cursor);
}

/** Finds literal values by syntax, including type annotations and multiline initializers. */
function maskSecretAssignments(content: string, relativePath: string): string {
  const source = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true);
  const ranges: Array<{ start: number; end: number }> = [];
  const visit = (node: ts.Node): void => {
    let name: ts.Node | undefined;
    let value: ts.Expression | undefined;
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node) || ts.isParameter(node)) {
      name = node.name;
      value = node.initializer;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      name = node.left;
      value = node.right;
    }
    if (name && value && SECRET_NAME.test(name.getText(source))) {
      while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isTypeAssertionExpression(value)) {
        value = value.expression;
      }
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) || ts.isTemplateExpression(value)) {
        ranges.push({ start: value.getStart(source) + 1, end: value.getEnd() - 1 });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  let cursor = 0;
  const parts: string[] = [];
  for (const { start, end } of ranges) {
    parts.push(content.slice(cursor, start), content.slice(start, end).replace(/[^\r\n]+/gu, REDACTED_VALUE));
    cursor = end;
  }
  return parts.join('') + content.slice(cursor);
}

function maskSecrets(content: string, relativePath: string): string {
  const withoutKeys = content.replace(PRIVATE_KEY_BLOCK, (block) =>
    block.split('\n').map(() => REDACTED_KEY_LINE).join('\n'),
  );
  const inlineMasked = withoutKeys.split('\n').map(maskInlineSecretAssignments).join('\n');
  return TOKEN_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED_VALUE), maskSecretAssignments(inlineMasked, relativePath));
}

function hasAnalyzableText(lines: readonly string[]): boolean {
  return lines.some((line) => !['', REDACTED_KEY_LINE, REDACTED_VALUE].includes(line.trim()));
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

  const masked = maskSecrets(snippet.content, snippet.path);
  if (masked === snippet.content) return { snippet, reasons: [], redactedLines: [] };

  const original = snippet.content.split('\n');
  const lines = masked.split('\n');
  const redactedLines = lines.flatMap((line, index) => (line === original[index] ? [] : [snippet.startLine + index]));
  if (!hasAnalyzableText(lines)) {
    return { snippet: null, reasons: ['masked-unanalyzable'], redactedLines };
  }
  return {
    snippet: { ...snippet, content: masked, contentHash: sha256(masked), redactedLines },
    reasons: ['secret-masked'],
    redactedLines,
  };
}

/** Slice only after full-source masking, retaining absolute redaction positions and hashing sent text. */
export function sliceFilteredSecuritySnippet(
  filtered: OutboundFilterResult,
  range: Pick<SecuritySnippet, 'snippetId' | 'startLine' | 'endLine'>,
): OutboundFilterResult {
  const redactedLines = filtered.redactedLines.filter((line) => line >= range.startLine && line <= range.endLine);
  if (!filtered.snippet) return { ...filtered, redactedLines };
  const source = filtered.snippet;
  const lines = source.content.split('\n').slice(range.startLine - source.startLine, range.endLine - source.startLine + 1);
  if (!hasAnalyzableText(lines)) return { snippet: null, reasons: ['masked-unanalyzable'], redactedLines };
  const content = lines.join('\n');
  return {
    snippet: { ...source, ...range, content, contentHash: sha256(content), redactedLines },
    reasons: redactedLines.length > 0 ? ['secret-masked'] : [],
    redactedLines,
  };
}
