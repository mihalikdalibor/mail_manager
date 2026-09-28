import { TestGroundError } from './errors.js';
import type { TestFolder } from './folder.js';

/**
 * Deletes the whole mm-test folder (IMAP DELETE — never EXPUNGE, never a flag change) and
 * reports how many messages went with it. A missing folder is not an error.
 */
export async function unseedTestGround(
  folder: TestFolder,
): Promise<{ deleted: boolean; messages: number }> {
  if (!(await folder.exists())) return { deleted: false, messages: 0 };
  const messages = await folder.messageCount();
  await folder.remove();
  // A dropped connection can make imapflow report success without deleting anything.
  if (await folder.exists()) throw new TestGroundError('mm-test is still there after deleting it.');
  return { deleted: true, messages };
}
