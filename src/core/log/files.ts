import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogKind } from './events.js';
import { LOG_FILE_RE, nameDateMs } from './file-event-log.js';

// The day files of the log folder, for reading them back (`mm logs`) and deleting them
// (`mm logs clear`). The folder itself is never followed through a symlink.

/** `missing`: no logs yet. `not-a-folder`: a symlink or a file. `unreadable`: no access. */
export type LogFolderStatus = 'ok' | 'missing' | 'not-a-folder' | 'unreadable';

export interface DayFile {
  kind: LogKind;
  /** UTC date from the name, `YYYY-MM-DD`. */
  date: string;
  path: string;
}

export interface DayFileList {
  status: LogFolderStatus;
  /** Identity of the folder when it was listed (`ok` only): a later swap is detected. */
  folderId?: { dev: number; ino: number };
  /** Sorted by date, app before security; names only (the files aren't checked here). */
  files: DayFile[];
}

async function folderStatus(
  dir: string,
): Promise<{ status: LogFolderStatus; folderId?: { dev: number; ino: number } }> {
  try {
    const st = await lstat(dir);
    return st.isDirectory()
      ? { status: 'ok', folderId: { dev: st.dev, ino: st.ino } }
      : { status: 'not-a-folder' };
  } catch (err) {
    return { status: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

/** Still the same real folder that was listed (not swapped for a symlink or another folder). */
async function sameFolder(dir: string, id: { dev: number; ino: number }): Promise<boolean> {
  try {
    const st = await lstat(dir);
    return st.isDirectory() && st.dev === id.dev && st.ino === id.ino;
  } catch {
    return false;
  }
}

/** Names matching `app|security-YYYY-MM-DD.log` with a real date. */
export async function listDayFiles(dir: string): Promise<DayFileList> {
  const { status, folderId } = await folderStatus(dir);
  if (status !== 'ok' || folderId === undefined) return { status, files: [] };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { status: 'unreadable', files: [] };
  }
  const files: DayFile[] = [];
  for (const name of names) {
    const match = LOG_FILE_RE.exec(name);
    const date = match?.[2] ?? '';
    if (match === null || nameDateMs(date) === null) continue;
    files.push({ kind: match[1] as LogKind, date, path: join(dir, name) });
  }
  files.sort((a, b) =>
    a.date === b.date
      ? Number(a.kind === 'security') - Number(b.kind === 'security')
      : a.date < b.date
        ? -1
        : 1,
  );
  return { status, folderId, files };
}

/** Day files that are regular files right now (lstat: a symlink is never counted). */
export async function regularDayFiles(dir: string): Promise<DayFileList> {
  const list = await listDayFiles(dir);
  const files: DayFile[] = [];
  for (const file of list.files) {
    try {
      if ((await lstat(file.path)).isFile()) files.push(file);
    } catch {
      // Gone meanwhile.
    }
  }
  return { ...list, files };
}

/**
 * Deletes the listed day files of `dir`. Before each file the folder must still be the one
 * that was listed (a prompt can sit open for a long time; a folder swapped for a symlink
 * meanwhile would redirect the deletes) and the file still a regular file. Returns how many
 * were deleted, and whether it stopped because the folder changed.
 */
export async function deleteDayFiles(
  dir: string,
  list: DayFileList,
): Promise<{ deleted: number; folderChanged: boolean }> {
  let deleted = 0;
  if (list.folderId === undefined) return { deleted, folderChanged: list.files.length > 0 };
  for (const file of list.files) {
    if (!(await sameFolder(dir, list.folderId))) return { deleted, folderChanged: true };
    try {
      if (!(await lstat(file.path)).isFile()) continue;
      await unlink(file.path);
      deleted++;
    } catch {
      // Gone meanwhile or not ours to delete: not counted.
    }
  }
  return { deleted, folderChanged: false };
}
