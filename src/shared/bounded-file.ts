import { open, type FileHandle } from 'node:fs/promises';

export async function readFileWithinByteLimit(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    return await readHandleWithinByteLimit(handle, maxBytes, label);
  } finally {
    await handle.close();
  }
}

/** Reads an already opened file so callers can verify the same descriptor they stat. */
export async function readHandleWithinByteLimit(
  handle: FileHandle,
  maxBytes: number,
  label: string,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} byte limit`);
  }
  return buffer.subarray(0, offset).toString('utf8');
}
