import {writeFileSync, renameSync, unlinkSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';

// A new private inode also preserves input bytes if a target alias changes.
export function writePrivate(path, content) {
  const temporary = join(dirname(path), '.report-' + randomUUID());
  try {
    writeFileSync(temporary, content, {mode: 0o600, flag: 'wx'});
    renameSync(temporary, path);
  } finally {
    try {unlinkSync(temporary);} catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
}
