// Which assistants the vault is allowed to read.
//
// Importing someone's Cursor and Cline history because it happens to be on the
// disk is a decision, not a detail, so it is recorded where they can see it
// and change it: ~/.claude-vault/.arca/sources.json.
//
// Local, and deliberately not committed. Two machines can hold different
// assistants and want different answers, and a choice made on one should not
// arrive on the other with a pull.
import fs from 'node:fs';
import path from 'node:path';
import { vaultDir } from '../transcripts.js';

const file = () => path.join(vaultDir(), '.arca', 'sources.json');

/**
 * @returns {{chosen: boolean, enabled: string[], updated: string|null}}
 */
export function load() {
  try {
    const doc = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(doc.enabled)) {
      return { chosen: true, enabled: doc.enabled, updated: doc.updated || null };
    }
  } catch { /* never asked */ }
  return { chosen: false, enabled: [], updated: null };
}

export function save(enabled) {
  const dest = file();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const body = JSON.stringify({ enabled: [...enabled].sort(), updated: new Date().toISOString() }, null, 2);
  // Written and renamed: an interrupted write here would read back as "never
  // asked" and quietly widen what gets imported.
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${body}\n`);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

/**
 * Has this source been turned on?
 *
 * Until a choice is recorded, everything detected counts as on — `arca sources
 * --import` is already an explicit instruction, and refusing to act on it
 * until a separate command has been run would be a riddle, not a safeguard.
 */
export function isEnabled(id, selection = load()) {
  return selection.chosen ? selection.enabled.includes(id) : true;
}
