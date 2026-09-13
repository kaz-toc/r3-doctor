import { describe, expect, it } from 'vitest';

import { filterSecuritySnippet, securityPathExclusionReason } from '../../src/addons/security/outbound-filter.js';
import type { SecuritySnippet } from '../../src/addons/security/types.js';
import { sha256 } from '../helpers/security-snapshot.js';

function snippet(content: string, overrides: Partial<SecuritySnippet> = {}): SecuritySnippet {
  return {
    snippetId: 'snippet:1',
    path: 'src/config.ts',
    revision: 'current',
    startLine: 1,
    endLine: content.split('\n').length,
    content,
    contentHash: sha256(content),
    ...overrides,
  };
}

describe('outbound security filter', () => {
  it.each([
    '// const password = "example-secret";',
    'const example = \'password = "example-secret"\';',
    'const view = <input password="example-secret" />;',
  ])('REG-2026-030 retains masking for inline assignments in unparsed text: %s', (content) => {
    expect(filterSecuritySnippet(snippet(content)).snippet?.content).not.toContain('example-secret');
  });

  it('masks secret values without removing source lines', () => {
    const content = 'const password = "example-secret";\nexport const ok = true;\n';
    const result = filterSecuritySnippet({
      snippetId: 'snippet:1', path: 'src/config.ts', revision: 'current',
      startLine: 1, endLine: 2, content, contentHash: 'a'.repeat(64),
    });
    expect(result.snippet?.content).not.toContain('example-secret');
    expect(result.snippet?.content.split('\n').length).toBe(content.split('\n').length);
  });

  it('masks private keys and known token formats while keeping line positions', () => {
    const secrets = [
      'AKIAABCDEFGHIJKLMNOP',
      `ghp_${'a'.repeat(36)}`,
      `sk-ant-api03-${'b'.repeat(40)}`,
      `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${'c'.repeat(43)}`,
    ];
    const content = [
      'const region = "us-east-1";',
      `const awsKey = "${secrets[0]}";`,
      `headers.set("x-api", "${secrets[1]}");`,
      `const client = new Anthropic({ apiKey: '${secrets[2]}' });`,
      `const session = '${secrets[3]}';`,
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA7',
      '-----END RSA PRIVATE KEY-----',
      'export const ok = true;',
    ].join('\n');

    const result = filterSecuritySnippet(snippet(content, { startLine: 10, endLine: 18 }));
    const lines = result.snippet?.content.split('\n') ?? [];

    for (const secret of [...secrets, 'MIIEowIBAAKCAQEA7']) {
      expect(result.snippet?.content).not.toContain(secret);
    }
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe('const region = "us-east-1";');
    expect(lines[8]).toBe('export const ok = true;');
    expect(result.redactedLines).toEqual([11, 12, 13, 14, 15, 16, 17]);
    expect(result.snippet?.redactedLines).toEqual([11, 12, 13, 14, 15, 16, 17]);
    expect(result.reasons).toEqual(['secret-masked']);
  });

  it('hashes the sent text separately from the original text', () => {
    const content = 'const token = "abcd1234efgh5678";\n';
    const masked = filterSecuritySnippet(snippet(content));
    expect(masked.snippet?.contentHash).toBe(sha256(masked.snippet?.content ?? ''));
    expect(masked.snippet?.contentHash).not.toBe(sha256(content));

    const plain = 'export const ok = true;\n';
    expect(filterSecuritySnippet(snippet(plain)).snippet?.contentHash).toBe(sha256(plain));
  });

  it('leaves ordinary identifiers, property reads, and Japanese text untouched', () => {
    const content = [
      "const tokenize = (value) => value.split(' ');",
      'const passwordField = form.password;',
      "const label = 'パスワードを入力してください';",
    ].join('\n');
    expect(filterSecuritySnippet(snippet(content))).toEqual({
      snippet: snippet(content),
      reasons: [],
      redactedLines: [],
    });
  });

  it('excludes secret files, credentials, generated output, and unsafe paths', () => {
    expect(securityPathExclusionReason('.env')).toBe('secret-file');
    expect(securityPathExclusionReason('config/.env.production')).toBe('secret-file');
    expect(securityPathExclusionReason('deploy/id_rsa')).toBe('secret-file');
    expect(securityPathExclusionReason('certs/server.pem')).toBe('secret-file');
    expect(securityPathExclusionReason('src/credentials.ts')).toBe('credential-file');
    expect(securityPathExclusionReason('src/aws-secrets.js')).toBe('credential-file');
    expect(securityPathExclusionReason('dist/app.js')).toBe('generated-file');
    expect(securityPathExclusionReason('src/generated/client.ts')).toBe('generated-file');
    expect(securityPathExclusionReason('types/index.d.ts')).toBe('generated-file');
    expect(securityPathExclusionReason('public/app.min.js')).toBe('generated-file');
    expect(securityPathExclusionReason('../outside.ts')).toBe('unsafe-path');
    expect(securityPathExclusionReason('src/a\nb.ts')).toBe('unsafe-path');
    expect(securityPathExclusionReason('src/orders.ts')).toBeNull();
    expect(securityPathExclusionReason('src/secretary.ts')).toBeNull();
    expect(securityPathExclusionReason('src/token-service.ts')).toBeNull();

    expect(filterSecuritySnippet(snippet('export {};', { path: '.env' })))
      .toEqual({ snippet: null, reasons: ['secret-file'], redactedLines: [] });
  });

  it('drops binary content and snippets that masking leaves without code', () => {
    expect(filterSecuritySnippet(snippet('abc\u0000def'))).toEqual({ snippet: null, reasons: ['binary-content'], redactedLines: [] });

    const keyOnly = '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----';
    const result = filterSecuritySnippet(snippet(keyOnly));
    expect(result.snippet).toBeNull();
    expect(result.reasons).toEqual(['masked-unanalyzable']);
  });
});
