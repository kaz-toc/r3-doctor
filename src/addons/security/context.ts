import { createHash } from 'node:crypto';
import path from 'node:path';

import ts from 'typescript';

import { resolveRelativeImport } from '../../evidence/deterministic.js';
import type { RepositorySnapshot } from '../../intake/snapshot.js';
import { LANGUAGE_EXTENSIONS } from '../../plugins/language-extensions.js';
import type { SecurityRevision } from '../../schema/security-assessment.v1.js';

import { securityPathExclusionReason } from './outbound-filter.js';
import type { SecurityUnit } from './types.js';

export const SECURITY_SELECTOR_VERSION = '1.0.1';
export const SECURITY_ANALYSIS_MAX_FILE_BYTES = 1_048_576;
export const SECURITY_UNIT_WINDOW_LINES = 160;
export const SECURITY_UNIT_WINDOW_OVERLAP = 20;
export const SECURITY_MAX_RELATED_UNITS = 8;

const SUPPORTED_EXTENSIONS = new Set(LANGUAGE_EXTENSIONS['typescript-javascript']);
const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

/** Static cues used only to prioritize units. A cue is never treated as a confirmed vulnerability. */
const CUES: ReadonlyArray<{ id: string; weight: number; pattern: RegExp }> = [
  {
    id: 'http-handler',
    weight: 3,
    pattern: /\b(?:app|router|server|fastify|api)\s*\.\s*(?:get|post|put|patch|delete|all|route|use)\s*\(|export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b|\(\s*req\b/u,
  },
  {
    id: 'external-input',
    weight: 2,
    pattern: /\b(?:req|request|ctx)\s*\.\s*(?:body|query|params|headers|cookies|files?)\b|\bsearchParams\b|\bformData\s*\(|\brequest\s*\.\s*json\s*\(|\bprocess\s*\.\s*argv\b/u,
  },
  {
    id: 'sql-sink',
    weight: 3,
    pattern: /\.\s*(?:query|execute|raw|\$queryRawUnsafe|\$executeRawUnsafe|\$queryRaw|\$executeRaw)\s*\(|\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:\*|INTO|FROM|[A-Za-z_])/u,
  },
  { id: 'command-sink', weight: 3, pattern: /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(|child_process/u },
  { id: 'code-sink', weight: 3, pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\s*\.\s*run|\b(?:deserialize|unserialize)\s*\(|\byaml\s*\.\s*load\s*\(/u },
  { id: 'http-sink', weight: 2, pattern: /\bfetch\s*\(|\baxios\b|\bgot\s*\(|\bhttps?\s*\.\s*(?:get|request)\s*\(/u },
  {
    id: 'file-sink',
    weight: 2,
    pattern: /\b(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|unlink|rm|sendFile|download)\s*\(/u,
  },
  { id: 'html-sink', weight: 2, pattern: /\binnerHTML\b|dangerouslySetInnerHTML|\bdocument\s*\.\s*write\s*\(|\binsertAdjacentHTML\s*\(/u },
  { id: 'crypto-use', weight: 1, pattern: /\bcreateHash\s*\(\s*['"](?:md5|sha1)['"]|\bcreateCipher\s*\(|\bMath\s*\.\s*random\s*\(|\bjwt\s*\.\s*(?:sign|verify|decode)\s*\(/u },
  {
    id: 'guard',
    weight: 1,
    pattern: /\b(?:authorize|authenticate|isAuthenticated|requireAuth\w*|requireUser|requireAdmin|checkPermission\w*|hasPermission|canAccess|ensureAuth\w*)\b|\b(?:req|request|ctx)\s*\.\s*(?:user|session)\b|\bsession\s*\.\s*user\b|\bpassport\s*\./u,
  },
];

const DYNAMIC_LIMITATIONS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'dynamic-import', pattern: /\bimport\s*\(\s*(?!['"`])/u },
  { id: 'dynamic-require', pattern: /\brequire\s*\(\s*(?!['"`])/u },
  { id: 'computed-call', pattern: /\]\s*\(/u },
];

export type SecurityBaseSource = { path: string; content: string };

export type SecuritySourceAnalysis = {
  /** Units for every analyzable source, ordered by path, revision, and line. */
  units: SecurityUnit[];
  /** Analyzed source text keyed by `securitySourceKey()`. Internal only. */
  sources: ReadonlyMap<string, string>;
  /** Current-revision files kept out of scope, counted by reason. */
  excludedByReason: Record<string, number>;
  oversized: Array<{ path: string; revision: SecurityRevision }>;
};

type DeclaredUnit = { anchor: string; startLine: number; endLine: number; names: string[] };

type ImportBinding = { local: string; imported: string; specifier: string; target: string | null };

type AnalyzedUnit = DeclaredUnit & {
  key: string;
  path: string;
  revision: SecurityRevision;
  text: string;
  tokens: ReadonlySet<string>;
  cues: string[];
  priority: number;
  limitations: Set<string>;
  related: Set<AnalyzedUnit>;
};

type ParsedSource = { path: string; revision: SecurityRevision; bindings: ImportBinding[]; units: AnalyzedUnit[] };

export function securitySourceKey(revision: SecurityRevision, relativePath: string): string {
  return `${revision}\u0000${relativePath}`;
}

/** Returns why a path is outside the security analysis scope, or null when it can be analyzed. */
export function securityPathScopeReason(relativePath: string): string | null {
  return securityPathExclusionReason(relativePath)
    ?? (SUPPORTED_EXTENSIONS.has(path.posix.extname(relativePath)) ? null : 'unsupported-language');
}

function increment(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function isFunctionLike(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return isFunctionLike(node.expression);
  }
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
    || (ts.isCallExpression(node) && node.arguments.some(isFunctionLike));
}

function isSkipped(statement: ts.Statement): boolean {
  return ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement) || ts.isExportDeclaration(statement)
    || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement)
    || (ts.isModuleDeclaration(statement) && (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Ambient) !== 0);
}

function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
  }
  if (ts.isEnumDeclaration(statement)) return [statement.name.text];
  if (ts.isExportAssignment(statement)) return ['default'];
  return [];
}

function classUnits(
  sourceFile: ts.SourceFile,
  node: ts.ClassDeclaration,
  rangeOf: (node: ts.Node) => { startLine: number; endLine: number },
): DeclaredUnit[] {
  const className = node.name?.text ?? 'default';
  const members = node.members.flatMap((member): DeclaredUnit[] => {
    if (ts.isConstructorDeclaration(member) && member.body) {
      return [{ anchor: `constructor:${className}`, ...rangeOf(member), names: [className] }];
    }
    const isMethod = (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
      && member.body !== undefined;
    const isProperty = ts.isPropertyDeclaration(member) && member.initializer !== undefined;
    if ((isMethod || isProperty) && member.name) {
      const kind = isMethod || (isProperty && isFunctionLike(member.initializer!)) ? 'method' : 'field';
      return [{ anchor: `${kind}:${className}.${member.name.getText(sourceFile)}`, ...rangeOf(member), names: kind === 'field' ? [className] : [] }];
    }
    if (ts.isClassStaticBlockDeclaration(member)) {
      return [{ anchor: `static-block:${className}`, ...rangeOf(member), names: [className] }];
    }
    return [];
  });
  return members.length > 0 ? members : [{ anchor: `class:${className}`, ...rangeOf(node), names: [className] }];
}

/** Splits top-level code into functions, class members, handler calls, and runs of unowned statements. */
function declaredUnits(sourceFile: ts.SourceFile): DeclaredUnit[] {
  const units: DeclaredUnit[] = [];
  let run: DeclaredUnit | undefined;
  const rangeOf = (node: ts.Node) => ({ startLine: lineOf(sourceFile, node.getStart(sourceFile)), endLine: lineOf(sourceFile, node.getEnd()) });
  const flush = () => {
    if (run) units.push(run);
    run = undefined;
  };
  const push = (anchor: string, node: ts.Node, names: string[]) => {
    flush();
    units.push({ anchor, ...rangeOf(node), names });
  };

  for (const statement of sourceFile.statements) {
    if (isSkipped(statement)) continue;
    const declaration = ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
      ? statement.declarationList.declarations[0]
      : undefined;
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? 'default';
      const isDefault = (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Default) !== 0;
      push(`function:${name}`, statement, isDefault && name !== 'default' ? [name, 'default'] : [name]);
    } else if (ts.isClassDeclaration(statement)) {
      flush();
      units.push(...classUnits(sourceFile, statement, rangeOf));
    } else if (declaration?.initializer && ts.isIdentifier(declaration.name) && isFunctionLike(declaration.initializer)) {
      push(`function:${declaration.name.text}`, statement, [declaration.name.text]);
    } else if (
      ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
      && statement.expression.arguments.some(isFunctionLike)
    ) {
      const callee = statement.expression.expression.getText(sourceFile).replace(/\s+/gu, '').slice(0, 80);
      push(`call:${callee}`, statement, []);
    } else if (ts.isExportAssignment(statement) && isFunctionLike(statement.expression)) {
      push('function:default', statement, ['default']);
    } else {
      const range = rangeOf(statement);
      run = run
        ? { ...run, endLine: range.endLine, names: [...run.names, ...declaredNames(statement)] }
        : { anchor: 'statements', ...range, names: declaredNames(statement) };
    }
  }
  flush();
  // Repeated callees (and other repeated symbol anchors) identify separate declarations, not one location.
  const counts = new Map<string, number>();
  for (const unit of units) counts.set(unit.anchor, (counts.get(unit.anchor) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return units.map((unit) => {
    if (counts.get(unit.anchor) === 1) return unit;
    const occurrence = (occurrences.get(unit.anchor) ?? 0) + 1;
    occurrences.set(unit.anchor, occurrence);
    return { ...unit, anchor: `${unit.anchor}#occurrence-${occurrence}` };
  });
}

function importBindings(sourceFile: ts.SourceFile, fromPath: string, availablePaths: ReadonlySet<string>): ImportBinding[] {
  return sourceFile.statements.flatMap((statement): ImportBinding[] => {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const specifier = statement.moduleSpecifier.text;
    const target = specifier.startsWith('.') ? resolveRelativeImport({ relativePath: fromPath }, specifier, availablePaths) : null;
    const clause = statement.importClause;
    const bindings: ImportBinding[] = clause.name ? [{ local: clause.name.text, imported: 'default', specifier, target }] : [];
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.push({ local: clause.namedBindings.name.text, imported: '*', specifier, target });
    } else if (clause.namedBindings) {
      for (const element of clause.namedBindings.elements) {
        bindings.push({ local: element.name.text, imported: (element.propertyName ?? element.name).text, specifier, target });
      }
    }
    return bindings;
  });
}

function parseSource(
  input: { path: string; revision: SecurityRevision; content: string },
  availablePaths: ReadonlySet<string>,
): ParsedSource {
  const extension = path.posix.extname(input.path);
  const sourceFile = ts.createSourceFile(input.path, input.content, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extension]);
  const lines = input.content.split('\n');
  const units = declaredUnits(sourceFile).map((declared): AnalyzedUnit => {
    const text = lines.slice(declared.startLine - 1, declared.endLine).join('\n');
    const cues = CUES.filter((cue) => cue.pattern.test(text));
    return {
      ...declared,
      key: `${securitySourceKey(input.revision, input.path)}\u0000${declared.anchor}\u0000${declared.startLine}`,
      path: input.path,
      revision: input.revision,
      text,
      tokens: new Set(text.match(/[A-Za-z_$][\w$]*/gu) ?? []),
      cues: cues.map((cue) => cue.id),
      priority: cues.reduce((total, cue) => total + cue.weight, 0),
      limitations: new Set(DYNAMIC_LIMITATIONS.filter((limitation) => limitation.pattern.test(text)).map((limitation) => limitation.id)),
      related: new Set(),
    };
  });
  return { path: input.path, revision: input.revision, bindings: importBindings(sourceFile, input.path, availablePaths), units };
}

function link(left: AnalyzedUnit, right: AnalyzedUnit): void {
  if (left === right) return;
  left.related.add(right);
  right.related.add(left);
}

function escapeIdentifier(identifier: string): string {
  return identifier.replaceAll('$', '\\$');
}

/** Resolves direct dependencies, callers, and guards from static imports and simple same-file references. */
function relateUnits(parsed: readonly ParsedSource[]): void {
  const currentByPath = new Map(parsed.filter((source) => source.revision === 'current').map((source) => [source.path, source]));
  for (const source of parsed) {
    for (const unit of source.units) {
      for (const binding of source.bindings) {
        if (!unit.tokens.has(binding.local)) continue;
        if (!binding.specifier.startsWith('.')) {
          const middleware = new RegExp(`\\.\\s*(?:use|get|post|put|patch|delete|all)\\s*\\([^;]*\\b${escapeIdentifier(binding.local)}\\b`, 'u');
          if (middleware.test(unit.text)) unit.limitations.add('external-middleware');
          continue;
        }
        const target = binding.target ? currentByPath.get(binding.target) : undefined;
        if (!target) {
          unit.limitations.add('unresolved-import');
          continue;
        }
        for (const candidate of target.units) {
          const matches = binding.imported === '*'
            ? candidate.names.some((name) => unit.tokens.has(name))
            : candidate.names.includes(binding.imported);
          if (matches) link(unit, candidate);
        }
      }
      for (const candidate of source.units) {
        if (candidate !== unit && candidate.names.some((name) => unit.tokens.has(name))) link(unit, candidate);
      }
    }
  }
}

function unitIdOf(unit: { path: string; revision: SecurityRevision; anchor: string; startLine: number; endLine: number }): string {
  const digest = createHash('sha256')
    .update(`${unit.revision}\u0000${unit.path}\u0000${unit.anchor}\u0000${unit.startLine}\u0000${unit.endLine}`)
    .digest('hex');
  return `unit:${digest.slice(0, 16)}`;
}

function windowsOf(unit: AnalyzedUnit): Array<{ anchor: string; startLine: number; endLine: number }> {
  if (unit.endLine - unit.startLine + 1 <= SECURITY_UNIT_WINDOW_LINES) {
    return [{ anchor: unit.anchor, startLine: unit.startLine, endLine: unit.endLine }];
  }
  const windows: Array<{ anchor: string; startLine: number; endLine: number }> = [];
  const step = SECURITY_UNIT_WINDOW_LINES - SECURITY_UNIT_WINDOW_OVERLAP;
  for (let startLine = unit.startLine, index = 1; ; startLine += step, index += 1) {
    const endLine = Math.min(startLine + SECURITY_UNIT_WINDOW_LINES - 1, unit.endLine);
    windows.push({ anchor: `${unit.anchor}#window-${index}`, startLine, endLine });
    if (endLine === unit.endLine) return windows;
  }
}

type UnitPosition = Pick<SecurityUnit, 'path' | 'revision' | 'startLine' | 'endLine'>;

function compareUnits(left: UnitPosition, right: UnitPosition): number {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.revision !== right.revision) return left.revision < right.revision ? -1 : 1;
  return left.startLine - right.startLine || left.endLine - right.endLine;
}

/**
 * Parses analyzable current files, plus optional base-revision sources, into prioritized units with related
 * units. It reads only the immutable snapshot and supplied base text, never the live filesystem.
 */
export function analyzeSecuritySources(
  snapshot: RepositorySnapshot,
  baseSources: readonly SecurityBaseSource[] = [],
): SecuritySourceAnalysis {
  const availablePaths = new Set(snapshot.files.map((file) => file.relativePath.replaceAll('\\', '/')));
  const inputs = [
    ...snapshot.files.map((file) => ({ path: file.relativePath.replaceAll('\\', '/'), revision: 'current' as const, content: file.content })),
    ...baseSources.map((source) => ({ path: source.path, revision: 'base' as const, content: source.content })),
  ];
  const excludedByReason: Record<string, number> = {};
  const oversized: SecuritySourceAnalysis['oversized'] = [];
  const sources = new Map<string, string>();
  const parsed: ParsedSource[] = [];

  for (const input of inputs) {
    const reason = securityPathScopeReason(input.path);
    if (reason) {
      if (input.revision === 'current') increment(excludedByReason, reason);
      continue;
    }
    if (Buffer.byteLength(input.content, 'utf8') > SECURITY_ANALYSIS_MAX_FILE_BYTES) {
      oversized.push({ path: input.path, revision: input.revision });
      continue;
    }
    sources.set(securitySourceKey(input.revision, input.path), input.content);
    parsed.push(parseSource(input, availablePaths));
  }
  relateUnits(parsed);

  const idsByKey = new Map(parsed.flatMap((source) => source.units).map((unit) => [
    unit.key,
    windowsOf(unit).map((window) => unitIdOf({ ...unit, ...window })),
  ]));
  const units = parsed.flatMap((source) => source.units).flatMap((unit) => {
    const related = [...unit.related]
      .sort((left, right) =>
        Number(right.cues.includes('guard')) - Number(left.cues.includes('guard'))
        || compareUnits(left, right));
    const limitations = new Set(unit.limitations);
    if (related.length > SECURITY_MAX_RELATED_UNITS) limitations.add('related-context-truncated');
    const kept = related.slice(0, SECURITY_MAX_RELATED_UNITS);
    return windowsOf(unit).map((window): SecurityUnit => ({
      unitId: unitIdOf({ ...unit, ...window }),
      path: unit.path,
      revision: unit.revision,
      startLine: window.startLine,
      endLine: window.endLine,
      priority: unit.priority,
      relatedPaths: [...new Set(kept.map((candidate) => candidate.path).filter((candidatePath) => candidatePath !== unit.path))].sort(),
      relatedUnitIds: kept.flatMap((candidate) => idsByKey.get(candidate.key) ?? []),
      limitations: [...limitations].sort(),
      anchor: window.anchor,
    }));
  });

  return { units: units.sort(compareUnits), sources, excludedByReason, oversized };
}

/** Current-revision units for every analyzable file in the snapshot. */
export function collectSecurityUnits(snapshot: RepositorySnapshot): SecurityUnit[] {
  return analyzeSecuritySources(snapshot).units;
}
