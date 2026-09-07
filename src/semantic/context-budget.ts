import type { RepositorySnapshot } from '../intake/snapshot.js';

export type ContextPacket = Readonly<{
  prompt: string;
  includedFilePaths: readonly string[];
  omittedFileCount: number;
}>;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function buildContextPacket(
  snapshot: RepositorySnapshot,
  maxPromptBytes: number,
): ContextPacket {
  const sections: string[] = [];
  const includedFilePaths: string[] = [];
  let usedBytes = 0;

  for (const file of snapshot.files) {
    const header = `\nFile: ${file.relativePath} (${file.nonBlankLines} non-blank lines)\n`;
    const body = file.content.length > 0 ? file.content : '(empty file)\n';
    const section = `${header}${body}`;
    const sectionBytes = utf8Bytes(section);
    if (usedBytes + sectionBytes > maxPromptBytes) {
      continue;
    }
    sections.push(section);
    includedFilePaths.push(file.relativePath);
    usedBytes += sectionBytes;
  }

  let omittedFileCount = snapshot.files.length - includedFilePaths.length;
  const render = (): string => [
    ...sections,
    ...(omittedFileCount > 0
      ? [`\n[omitted ${omittedFileCount} file(s) due to prompt byte budget]`]
      : []),
  ].join('');
  let prompt = render();
  while (utf8Bytes(prompt) > maxPromptBytes && sections.length > 0) {
    sections.pop();
    includedFilePaths.pop();
    omittedFileCount += 1;
    prompt = render();
  }
  if (utf8Bytes(prompt) > maxPromptBytes) {
    prompt = '';
  }

  return {
    prompt,
    includedFilePaths,
    omittedFileCount,
  };
}
