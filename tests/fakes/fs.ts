// The plugin's file seam (disk.ts `Fs`) in memory, as `$.fs` answers it: a missing file rejects ENOENT; `fail` makes a path's write or read reject with that error.
import type { Fs } from '../../plugins/forward-compaction/src/disk.ts';

export function memFs(files: Record<string, string> = {}, fail: { write?: Record<string, string>; read?: Record<string, string> } = {}): Fs & { files: Record<string, string> } {
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file, ${path}`), { code: 'ENOENT' });
  return {
    files,
    read: async (path) => {
      if (fail.read?.[path] !== undefined) throw new Error(fail.read[path]);
      if (!(path in files)) throw enoent(path);
      return files[path]!;
    },
    write: async (path, text) => {
      if (fail.write?.[path] !== undefined) throw new Error(fail.write[path]);
      files[path] = text;
    },
    exists: async (path) => path in files,
  };
}
