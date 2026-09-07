import type { CapabilityResult, Evidence, SignalId, SourceLanguage } from '../schema/report.v1.js';
import { ALL_SIGNAL_IDS, ASSESSMENT_CONTRACT_VERSION } from '../schema/report.v1.js';
import type { RepositorySnapshot, SourceFile } from '../intake/snapshot.js';
import type { ReportLocale } from '../i18n/locale.js';
import { resolveLocale } from '../i18n/locale.js';
import { t } from '../i18n/messages.js';
import { IntakeError } from '../shared/errors.js';
import { classifyPathRole } from '../evidence/path-role.js';
import {
  buildNumericRationale,
  normalizeAboveThreshold,
  severityForStrength,
} from '../evidence/strength.js';
import { LANGUAGE_EXTENSIONS } from './language-extensions.js';

export type AnalyzerCapability = {
  readonly language: SourceLanguage;
  readonly contractVersion: number;
  signals: readonly SignalId[];
  completeness: 'full' | 'partial';
};

export type AnalyzerPlugin = {
  readonly id: string;
  readonly implementationVersion: string;
  extensions: readonly string[];
  capabilities: readonly AnalyzerCapability[];
  extract(snapshot: RepositorySnapshot): Promise<Evidence[]>;
};

const TS_SIGNALS: SignalId[] = [
  'dep-cycle',
  'high-fan-out',
  'high-fan-in',
  'large-file',
  'missing-test-pair',
  'git-churn',
  'barrel-reexport',
  'deep-nesting',
  'unresolved-import',
];

function filterFiles(snapshot: RepositorySnapshot, extensions: readonly string[]): SourceFile[] {
  return snapshot.files.filter((file) => extensions.includes(file.extension));
}

function extractLargeFileEvidence(
  files: SourceFile[],
  snapshot: RepositorySnapshot,
  languageLabel: string,
  locale: ReportLocale,
): Evidence[] {
  return files
    .filter((file) => file.nonBlankLines > snapshot.config.maxFileLines)
    .map((file) => {
      const strength = normalizeAboveThreshold(file.nonBlankLines, snapshot.config.maxFileLines);
      return {
        evidenceId: `evidence:large-file:${file.relativePath}`,
        signalId: 'large-file' as const,
        axisId: 'structural-fragility' as const,
        path: file.relativePath,
        severity: severityForStrength(strength),
        message: t(locale, 'evidence.largeFileLanguage', {
          language: languageLabel,
          lines: file.nonBlankLines,
        }),
        metrics: { lines: file.nonBlankLines },
        source: 'deterministic' as const,
        strength,
        rationale: buildNumericRationale(file.nonBlankLines, snapshot.config.maxFileLines),
        pathRole: classifyPathRole(file.relativePath, snapshot.config.diagnosticSkipRoots),
        relatedPaths: [],
      };
    });
}

export function detectLanguages(snapshot: RepositorySnapshot): SourceLanguage[] {
  const present = new Set<string>();
  for (const file of snapshot.files) {
    present.add(file.extension);
  }
  return (Object.entries(LANGUAGE_EXTENSIONS) as Array<[SourceLanguage, readonly string[]]>)
    .filter(([, extensions]) => extensions.some((ext) => present.has(ext)))
    .map(([language]) => language);
}

export function selectPlugins(snapshot: RepositorySnapshot, plugins: AnalyzerPlugin[]): AnalyzerPlugin[] {
  const languages = new Set(detectLanguages(snapshot));
  const selected = plugins.filter((plugin) => plugin.capabilities.some((cap) => languages.has(cap.language)));
  const analyzerIds = selected.map((plugin) => plugin.id);
  if (new Set(analyzerIds).size !== analyzerIds.length) {
    throw new IntakeError('selected analyzer IDs must be unique');
  }
  for (const plugin of selected) {
    const capabilityLanguages = plugin.capabilities.map((capability) => capability.language);
    if (new Set(capabilityLanguages).size !== capabilityLanguages.length) {
      throw new IntakeError(`analyzer ${plugin.id} has ambiguous capabilities for the same language`);
    }
  }
  return selected.sort((left, right) =>
    `${left.id}:${left.implementationVersion}`.localeCompare(`${right.id}:${right.implementationVersion}`),
  );
}

export function negotiateCapabilities(
  snapshot: RepositorySnapshot,
  plugins: AnalyzerPlugin[],
): {
  capabilities: CapabilityResult[];
  supported: SignalId[];
  unevaluated: SignalId[];
} {
  const languages = detectLanguages(snapshot);
  const selected = selectPlugins(snapshot, plugins);
  const capabilities: CapabilityResult[] = [];

  for (const language of languages) {
    const contributors = selected.flatMap((plugin) => {
      const capability = plugin.capabilities.find((entry) => entry.language === language);
      return capability ? [{ plugin, capability }] : [];
    });
    if (contributors.length === 0) {
      capabilities.push({
        language,
        contractVersion: ASSESSMENT_CONTRACT_VERSION,
        completeness: 'partial',
        supportedSignals: [],
        unevaluatedSignals: [...ALL_SIGNAL_IDS],
        analyzerId: 'none',
        analyzerImplementationVersion: 'unavailable',
      });
      continue;
    }

    for (const { plugin, capability } of contributors) {
      const supportedSignals = capability.signals
        .filter((signal) => snapshot.gitAvailable || signal !== 'git-churn')
        .sort();
      const unevaluatedSignals = ALL_SIGNAL_IDS.filter((signal) => !supportedSignals.includes(signal));
      capabilities.push({
        language,
        contractVersion: capability.contractVersion,
        completeness: capability.completeness,
        supportedSignals,
        unevaluatedSignals,
        analyzerId: plugin.id,
        analyzerImplementationVersion: plugin.implementationVersion,
      });
    }
  }

  const supported = [...new Set(capabilities.flatMap((entry) => entry.supportedSignals))].sort();
  const unevaluated = ALL_SIGNAL_IDS.filter((signal) => !supported.includes(signal));
  return { capabilities, supported, unevaluated };
}

export class TypeScriptAnalyzerPlugin implements AnalyzerPlugin {
  readonly id = 'typescript-javascript-v1';
  readonly implementationVersion = '1.1.0';
  readonly extensions = LANGUAGE_EXTENSIONS['typescript-javascript'];
  readonly capabilities: AnalyzerCapability[] = [
    {
      language: 'typescript-javascript',
      contractVersion: ASSESSMENT_CONTRACT_VERSION,
      signals: TS_SIGNALS,
      completeness: 'full',
    },
  ];

  async extract(snapshot: RepositorySnapshot): Promise<Evidence[]> {
    const { extractDeterministicEvidence } = await import('../evidence/deterministic.js');
    const locale = resolveLocale(snapshot.config);
    return extractDeterministicEvidence({
      ...snapshot,
      files: filterFiles(snapshot, this.extensions),
    }, locale);
  }
}

export class PythonStubAnalyzerPlugin implements AnalyzerPlugin {
  readonly id = 'python-stub-v1';
  readonly implementationVersion = '1.0.0';
  readonly extensions = LANGUAGE_EXTENSIONS.python;
  readonly capabilities: AnalyzerCapability[] = [
    {
      language: 'python',
      contractVersion: ASSESSMENT_CONTRACT_VERSION,
      signals: ['large-file'],
      completeness: 'partial',
    },
  ];

  async extract(snapshot: RepositorySnapshot): Promise<Evidence[]> {
    const locale = resolveLocale(snapshot.config);
    return extractLargeFileEvidence(filterFiles(snapshot, this.extensions), snapshot, 'Python', locale);
  }
}

export class GoStubAnalyzerPlugin implements AnalyzerPlugin {
  readonly id = 'go-stub-v1';
  readonly implementationVersion = '1.0.0';
  readonly extensions = LANGUAGE_EXTENSIONS.go;
  readonly capabilities: AnalyzerCapability[] = [
    {
      language: 'go',
      contractVersion: ASSESSMENT_CONTRACT_VERSION,
      signals: ['large-file'],
      completeness: 'partial',
    },
  ];

  async extract(snapshot: RepositorySnapshot): Promise<Evidence[]> {
    const locale = resolveLocale(snapshot.config);
    return extractLargeFileEvidence(filterFiles(snapshot, this.extensions), snapshot, 'Go', locale);
  }
}

export function getDefaultPlugins(): AnalyzerPlugin[] {
  return [new TypeScriptAnalyzerPlugin(), new PythonStubAnalyzerPlugin(), new GoStubAnalyzerPlugin()];
}

export async function extractEvidenceWithPlugins(
  snapshot: RepositorySnapshot,
  plugins: AnalyzerPlugin[],
): Promise<{ evidence: Evidence[]; analyzerIds: string[]; capabilities: CapabilityResult[]; duplicateIds: string[] }> {
  const selected = selectPlugins(snapshot, plugins);
  const evidenceById = new Map<string, Evidence>();
  const duplicateIds: string[] = [];

  for (const plugin of selected) {
    const extracted = await plugin.extract(snapshot);
    for (const item of extracted) {
      if (evidenceById.has(item.evidenceId)) {
        duplicateIds.push(item.evidenceId);
      }
      evidenceById.set(item.evidenceId, item);
    }
  }

  if (duplicateIds.length > 0) {
    throw new IntakeError(`duplicate evidence IDs: ${[...new Set(duplicateIds)].join(', ')}`);
  }

  const negotiation = negotiateCapabilities(snapshot, selected);
  return {
    evidence: [...evidenceById.values()].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)),
    analyzerIds: selected.map((plugin) => plugin.id),
    capabilities: negotiation.capabilities,
    duplicateIds,
  };
}
