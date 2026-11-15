/**
 * Files the signer reads and writes (on-chain audit M-2). The signer runs as its own Unix user and must never act on
 * data the app user (api + workers) can change, so:
 *  - what it reads (the hot keys, the deployment file) must sit on a path only root and the signer control
 *    (untrustedPath: every directory on the way owned by root or the signer and not writable by group or others);
 *  - the keys file must not be readable by others either (root:<signer group> 640, or the signer's own 600);
 *  - its state lives in a directory of its own home that only it can enter (0700), files 0600, written atomically;
 *  - its status (no secrets) goes to a file the app user may read but not write, written atomically.
 * Nothing here ever prints a key: problems name the variable, never the value.
 */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { SIGNER_HOT_KEYS, type Hex } from '@velum/config/src/onchain';
import { validKey } from '../onchain/env';

const myUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

/** Larger files are never read (a keys file is two lines; a state file a few KB). */
const MAX_KEYS_FILE_BYTES = 64 * 1024;
const MAX_STATE_FILE_BYTES = 1024 * 1024;

/**
 * Why `p` is not a path that only root and this user (`uid`) control, or null. Every component, as written and after
 * resolving symbolic links, must be owned by root or `uid` and not writable by group or others; a root-owned sticky
 * directory (such as /tmp) may be on the way, since others cannot rename or remove what is inside it.
 */
export function untrustedPath(p: string, uid: number = myUid()): string | null {
  const walk = (abs: string): string | null => {
    const parts = abs.split('/').filter(Boolean);
    let cur = '/';
    for (let i = 0; i <= parts.length; i++) {
      if (i > 0) cur = path.join(cur, parts[i - 1]!);
      let st;
      try {
        st = lstatSync(cur);
      } catch {
        return `${cur} does not exist`;
      }
      if (st.uid !== 0 && st.uid !== uid) return `${cur} belongs to another user (uid ${st.uid})`;
      if (st.isSymbolicLink()) continue; // the link itself cannot change; its target is checked below
      const last = i === parts.length;
      const stickyRootDir = st.isDirectory() && (st.mode & 0o1000) !== 0 && st.uid === 0 && !last;
      if ((st.mode & 0o022) !== 0 && !stickyRootDir) return `${cur} is writable by group or others`;
    }
    return null;
  };
  const abs = path.resolve(p);
  const lexical = walk(abs);
  if (lexical) return lexical;
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return `${abs} does not exist`;
  }
  return real === abs ? null : walk(real);
}

/** Reads a small regular file without following a symbolic link in its last component. */
function readSmall(file: string, max: number): { data: string; uid: number; mode: number } {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (st.size > max) throw new Error(`${file} is larger than ${max} bytes`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { data: buf.subarray(0, off).toString('utf8'), uid: st.uid, mode: st.mode };
  } finally {
    closeSync(fd);
  }
}

export interface SignerKeys {
  /** PRICE_RELAY_PRIVATE_KEY, or null (absent or invalid: see problems). */
  relay(): Hex | null;
  /** KEEPER_PRIVATE_KEY, or null. */
  keeper(): Hex | null;
}

/**
 * The hot keys from SIGNER_KEYS_FILE (KEY=VALUE lines, the .env rules: no evaluation, one pair of outer quotes
 * removed). The file must be a regular file on a trusted path (untrustedPath), owned by root or this user, not
 * writable by its group and not readable by others. Only PRICE_RELAY_PRIVATE_KEY and KEEPER_PRIVATE_KEY are read;
 * a key set on two lines, a malformed key or one key for both roles is refused. The keys sit behind functions
 * (JSON.stringify and the logger skip functions); `problems` names variables, never values.
 */
export function readKeysFile(file: string, uid: number = myUid()): { keys: SignerKeys; problems: string[] } {
  const none: SignerKeys = { relay: () => null, keeper: () => null };
  const bad = untrustedPath(file, uid);
  if (bad) return { keys: none, problems: [`SIGNER_KEYS_FILE ${file}: ${bad}`] };
  let f: { data: string; uid: number; mode: number };
  try {
    f = readSmall(file, MAX_KEYS_FILE_BYTES);
  } catch (err) {
    return { keys: none, problems: [`SIGNER_KEYS_FILE ${file} cannot be read (${(err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : 'error')})`] };
  }
  if (f.uid !== 0 && f.uid !== uid) return { keys: none, problems: [`SIGNER_KEYS_FILE ${file} must be owned by root or the signer user`] };
  if ((f.mode & 0o027) !== 0) return { keys: none, problems: [`SIGNER_KEYS_FILE ${file} must not be writable by its group nor readable by others (root:<signer group> 640, or 600)`] };
  const values = new Map<string, string>();
  const problems: string[] = [];
  for (const raw of f.data.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m || !(SIGNER_HOT_KEYS as readonly string[]).includes(m[1]!)) continue;
    let v = m[2]!;
    if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1);
    if (values.has(m[1]!)) problems.push(`${m[1]} is set on more than one line in SIGNER_KEYS_FILE`);
    values.set(m[1]!, v);
  }
  const relay = validKey(values.get('PRICE_RELAY_PRIVATE_KEY'));
  const keeper = validKey(values.get('KEEPER_PRIVATE_KEY'));
  if (relay === 'invalid') problems.push('PRICE_RELAY_PRIVATE_KEY in SIGNER_KEYS_FILE is not a private key (0x + 64 hex digits). Create one with deploy/new-key.sh.');
  if (keeper === 'invalid') problems.push('KEEPER_PRIVATE_KEY in SIGNER_KEYS_FILE is not a private key (0x + 64 hex digits). Create one with deploy/new-key.sh.');
  const r = relay && relay !== 'invalid' ? relay : null;
  let k = keeper && keeper !== 'invalid' ? keeper : null;
  if (r && k && r.toLowerCase() === k.toLowerCase()) {
    problems.push('KEEPER_PRIVATE_KEY must not be the price-relay key: create a separate one with deploy/new-key.sh KEEPER_PRIVATE_KEY.');
    k = null;
  }
  const dup = problems.some((p) => p.includes('more than one line'));
  return { keys: { relay: () => (dup ? null : r), keeper: () => (dup ? null : k) }, problems };
}

/**
 * A directory in the signer's own home for its small state (cover-claim scan position, last quote per market): owned
 * by this user and closed to everyone else (created 0700; refused when it is a symbolic link, another user's, or open
 * to group or others). Files are 0600, written atomically (temp file, fsync, rename), read without following links.
 */
export class StateDir {
  constructor(readonly dir: string) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`SIGNER_STATE_DIR ${dir} is not a directory`);
    if (st.uid !== myUid()) throw new Error(`SIGNER_STATE_DIR ${dir} belongs to another user`);
    if ((st.mode & 0o077) !== 0) throw new Error(`SIGNER_STATE_DIR ${dir} must be closed to group and others (mode 700)`);
  }

  private file(name: string): string {
    if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error(`bad state name ${name}`);
    return path.join(this.dir, `${name}.json`);
  }

  /** The parsed JSON of `name`, or null (missing, unreadable, not ours, not JSON). */
  read(name: string): unknown {
    try {
      const f = readSmall(this.file(name), MAX_STATE_FILE_BYTES);
      if (f.uid !== myUid()) return null;
      return JSON.parse(f.data) as unknown;
    } catch {
      return null;
    }
  }

  write(name: string, value: unknown): void {
    writeAtomic(this.file(name), JSON.stringify(value), 0o600);
  }

  /** A { read, write } pair for one state file. */
  store(name: string): { read(): unknown; write(v: unknown): void } {
    return { read: () => this.read(name), write: (v) => this.write(name, v) };
  }
}

/** Writes `file` atomically: a new temp file next to it (O_EXCL, no link followed), fsync, mode, rename. */
export function writeAtomic(file: string, data: string, mode: number): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    writeSync(fd, data);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    throw err;
  }
}
