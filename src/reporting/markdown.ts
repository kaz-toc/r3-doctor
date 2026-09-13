export function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([`*_[\]{}()#+\-.!|])/g, '\\$1');
}

/** Escape dynamic values at the Markdown output boundary. */
export function markdown(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((result, literal, index) => result + literal + (index < values.length ? inlineText(String(values[index])) : ''), '');
}

function inlineText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([`*_[\]#!|])/g, '\\$1');
}

export function markdownCode(value: string): string {
  const text = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\|/g, '\\|');
  const runs = [...text.matchAll(/`+/g)].map(match => match[0].length);
  const fence = '`'.repeat(Math.max(0, ...runs) + 1);
  const padding = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ')) ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}
