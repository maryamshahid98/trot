// Moves uploaded files from one storage to another without trusting either: each file is checked against the fingerprint the
// database holds, before and after. Nothing is removed from the source, and running it again does no harm.
import type { FileStorage } from './file-storage.ts';

export interface CopyResult { copied: number; already: number; problems: { key: string; message: string }[] }

export async function copyFiles(files: { key: string; sha: string }[], from: FileStorage, to: FileStorage, fingerprint: (data: Buffer) => string): Promise<CopyResult> {
  const out: CopyResult = { copied: 0, already: 0, problems: [] };
  for (const { key, sha } of files) {
    const problem = (message: string) => out.problems.push({ key, message });
    const there = await to.read(key);
    if (there) {
      if (fingerprint(there) === sha) out.already++;
      else problem('a different file is already stored under this name; it was left alone');
      continue;
    }
    const data = await from.read(key);
    if (!data) { problem('missing from the source'); continue; }
    if (fingerprint(data) !== sha) { problem('the source file does not match its fingerprint; it was not copied'); continue; }
    await to.save(key, data);
    const back = await to.read(key);
    if (!back || fingerprint(back) !== sha) { problem('the copy does not match its fingerprint'); continue; }
    out.copied++;
  }
  return out;
}
