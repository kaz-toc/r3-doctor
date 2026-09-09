import type { LlmCatalogReport } from '../../schema/llm-catalog.v1.js';

import type { LlmProviderInspectRow } from './types.js';

export function formatLlmInspectStderr(row: LlmProviderInspectRow): string {
  if (row.status === 'available') {
    const lines = [`provider=${row.providerId} status=available`];
    if (row.agentInfo) {
      lines.push(
        `agent=${row.agentInfo.name}${row.agentInfo.version ? `@${row.agentInfo.version}` : ''}`,
      );
    }
    lines.push(`authMethods=${row.authMethods.join(',') || 'none'}`);
    return `${lines.join('\n')}\n`;
  }

  const lines = [
    `provider=${row.providerId} status=unavailable reason=${row.reason ?? 'process_exited'}`,
    `installHint=${row.installHint}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function formatLlmCatalogConsole(report: LlmCatalogReport): string {
  const lines = ['LLM providers:'];
  for (const provider of report.providers) {
    const aliasSuffix = provider.aliases.length > 0 ? ` aliases: ${provider.aliases.join(', ')}` : '';
    const base = `- ${provider.id} (${provider.displayName}) executable: ${provider.defaultExecutable}${aliasSuffix}`;
    if (provider.inspect.status === 'skipped') {
      lines.push(base);
      continue;
    }
    if (provider.inspect.status === 'available') {
      const agentSuffix = provider.inspect.agent ? ` agent: ${provider.inspect.agent}` : '';
      lines.push(`${base} status=available${agentSuffix}`);
      continue;
    }
    lines.push(`${base} status=unavailable reason=${provider.inspect.reason ?? 'unknown'}`);
  }
  if (report.operatorDefault) {
    lines.push(
      `Operator default: ${report.operatorDefault.provider} (${report.operatorDefault.profilePath})`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function formatLlmCatalogJson(report: LlmCatalogReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
