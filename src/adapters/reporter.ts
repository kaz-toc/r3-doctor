import type { DiagnosisReport, DiffReport } from '../schema/report.v1.js';
import { formatDiffReport, formatReport, type FormatReportOptions } from '../reporting/format.js';
import type { ReportView } from '../reporting/view-model.js';
import { formatGitHubAnnotations } from '../reporting/github.js';

export type ReportFormat = 'json' | 'markdown' | 'console';

export type ReporterOptions = FormatReportOptions;

export type ReporterAdapter = {
  format(report: DiagnosisReport, format: ReportFormat, options?: ReporterOptions): string;
  formatDiff(diff: DiffReport, format: ReportFormat, options?: ReporterOptions): string;
  formatGitHubAnnotations(diff: DiffReport): string;
};

export class DefaultReporterAdapter implements ReporterAdapter {
  format(report: DiagnosisReport, format: ReportFormat, options: ReporterOptions = {}): string {
    return formatReport(report, format, options);
  }

  formatDiff(diff: DiffReport, format: ReportFormat, options: ReporterOptions = {}): string {
    return formatDiffReport(diff, format, options);
  }

  formatGitHubAnnotations(diff: DiffReport): string {
    return formatGitHubAnnotations(diff);
  }
}

export { formatReport, formatDiffReport };
export type { ReportView };
