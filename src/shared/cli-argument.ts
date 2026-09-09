export function quoteCliArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
