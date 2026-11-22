// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It reads a patch in one of four formats (unified diffs,
// SEARCH/REPLACE blocks, V4A patches, JSON tool calls), finds the lines each edit names at the
// first of three matching tiers, and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and
// write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under SPEC.md section 3: its break, its lines, whether it ends with a break. */
interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function stripTrailingWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBothWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** One line of the new text: a context line (written as the file's own line) or a fresh line. */
interface NEntry {
  text: string;
  ctx: number | null;
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; strict: 0 only) at which o occurs at or after `from`, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** The new lines for a match: context lines as the file's own, other lines re-indented at tier 2. */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NEntry[], tier: number): string[] {
  const out: string[] = [];
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(o[0] ?? '');
  for (const e of n) {
    if (e.ctx !== null) {
      out.push(fileLines[pos + e.ctx]!);
    } else if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(e.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One body line of a unified hunk or a V4A chunk: context, old, or new. */
interface BodyItem {
  kind: ' ' | '-' | '+';
  text: string;
  /** A `\` line followed this body line: it ends without a line break. */
  noNl: boolean;
}

interface Hunk {
  a: number;
  body: BodyItem[];
}

interface UniSection {
  oldRaw: string | null;
  newRaw: string | null;
  /** A `--- `/`+++ ` pair named this path: it beats `rename from`/`rename to` (section 6). */
  pairOld: boolean;
  pairNew: boolean;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- ` or `+++ ` header line names, after the tab cut and the a//b/ prefix. */
function headerPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

/** A hunk's body: the lines after its header, trailing blank lines left out. */
function parseHunkBody(lines: string[], i: number): { body: BodyItem[]; next: number } {
  const raw: string[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      raw.push(l);
      j++;
    } else break;
  }
  while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
  const body: BodyItem[] = [];
  for (const l of raw) {
    if (l.startsWith('\\')) {
      if (body.length > 0) body[body.length - 1]!.noNl = true;
      continue;
    }
    body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1), noNl: false });
  }
  return { body, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (oldRaw: string | null, newRaw: string | null): void => {
    cur = { oldRaw, newRaw, pairOld: false, pairNew: false, newFile: false, delFile: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), body: parsed.body });
      inHeader = false;
      i = parsed.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.oldRaw = headerPath(l);
          cur.newRaw = headerPath(lines[i + 1]!);
          cur.pairOld = true;
          cur.pairNew = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        if (!cur.pairOld) cur.oldRaw = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur.pairNew) cur.newRaw = l.slice(10).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.delFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(headerPath(l), headerPath(lines[i + 1]!));
      i += 2;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One unified section as an edit (SPEC.md section 6). */
function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.oldRaw === null || sec.oldRaw === '/dev/null' ? null : sec.oldRaw;
    const newPath = sec.newRaw === null || sec.newRaw === '/dev/null' ? null : sec.newRaw;
    const creation = sec.oldRaw === '/dev/null' || sec.newFile;
    const deletion = sec.newRaw === '/dev/null' || sec.delFile;
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (creation) {
      const np = newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const ls: string[] = [];
      let lastPlusNoNl = false;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === '+') {
            ls.push(b.text);
            lastPlusNoNl = b.noNl;
          }
        }
      }
      tree.now.set(np, ls.length === 0 ? '' : ls.join('\n') + (!lastPlusNoNl ? '\n' : ''));
      return;
    }
    if (deletion) {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    const isMove = op !== np;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const st = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const o: string[] = [];
      const n: NEntry[] = [];
      for (const b of h.body) {
        if (b.kind === ' ') {
          o.push(b.text);
          n.push({ text: b.text, ctx: o.length - 1 });
        } else if (b.kind === '-') {
          o.push(b.text);
        } else {
          n.push({ text: b.text, ctx: null });
        }
      }
      if (o.length === 0) {
        const ins = Math.min(h.a + d, st.lines.length);
        const atEnd = ins === st.lines.length;
        st.lines.splice(ins, 0, ...n.map((e) => e.text));
        if (atEnd) {
          let lastPlus: BodyItem | undefined;
          for (let k = h.body.length - 1; k >= 0; k--) {
            if (h.body[k]!.kind === '+') {
              lastPlus = h.body[k]!;
              break;
            }
          }
          st.final = lastPlus !== undefined ? !lastPlus.noNl : true;
        }
        d += n.length;
      } else {
        const found = findTier(st.lines, o, strict, 0);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        for (const p of found.positions) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const atEnd = best + o.length === st.lines.length;
        const repl = buildReplacement(st.lines, best, o, n, found.tier);
        st.lines.splice(best, o.length, ...repl);
        if (atEnd) {
          let last: BodyItem | undefined;
          for (let k = h.body.length - 1; k >= 0; k--) {
            if (h.body[k]!.kind !== '-') {
              last = h.body[k]!;
              break;
            }
          }
          st.final = last !== undefined ? !last.noNl : true;
        }
        d += n.length - o.length;
      }
    }
    const text = joinFile(st);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, text);
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, text);
    }
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const found = findTier(st.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const n: NEntry[] = newLines.map((t) => ({ text: t, ctx: null }));
    const repl = buildReplacement(st.lines, pos, oldLines, n, found.tier);
    st.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(st));
  };
}

interface VChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

/** The first line at or after `from` equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** The first tier with an occurrence at or after `from` (an end-of-file chunk: ending at the last line). */
function findTierFrom(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrences(lines, o, t, from);
    if (eof) pos = pos.filter((p) => p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let prefix = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      prefix = '*** Add File: ';
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      prefix = '*** Delete File: ';
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      prefix = '*** Update File: ';
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const path = l.slice(prefix.length).trim();
    const headerLine = i + 1;
    let j = i + 1;
    while (j < last) {
      const lj = lines[j]!;
      if (lj.startsWith('*** Add File: ') || lj.startsWith('*** Delete File: ') || lj.startsWith('*** Update File: ')) break;
      j++;
    }
    const secLines = lines.slice(i + 1, j);
    const secStart = i + 1;
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!)) secLines.pop();
    edits.push(v4aEdit(kind, path, secLines, secStart, headerLine, strict));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One V4A section as an edit (SPEC.md section 8); its shape is read now, its files at apply time. */
function v4aEdit(kind: 'add' | 'delete' | 'update', path: string, secLines: string[], secStart: number, headerLine: number, strict: boolean): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let k = 0; k < secLines.length; k++) {
      const l = secLines[k]!;
      if (l.startsWith('+')) fileLines.push(l.slice(1));
      else if (l === '') fileLines.push('');
      else throw new Exit2(`error: parse ${secStart + k + 1}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    if (secLines.length > 0) throw new Exit2(`error: parse ${secStart + 1}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let lines = secLines;
  let lineBase = secStart;
  if (lines.length > 0 && lines[0]!.startsWith('*** Move to: ')) {
    moveTo = lines[0]!.slice('*** Move to: '.length).trim();
    lines = lines.slice(1);
    lineBase = secStart + 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]!;
    const ln = lineBase + k + 1;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: null, body: [], eof: false };
        } else {
          throw new Exit2(`error: parse ${ln}`);
        }
      }
      cur.body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1), noNl: false });
      continue;
    }
    throw new Exit2(`error: parse ${ln}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(st.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o: string[] = [];
      const n: NEntry[] = [];
      for (const b of ch.body) {
        if (b.kind === ' ') {
          o.push(b.text);
          n.push({ text: b.text, ctx: o.length - 1 });
        } else if (b.kind === '-') {
          o.push(b.text);
        } else {
          n.push({ text: b.text, ctx: null });
        }
      }
      if (o.length === 0) {
        const ins = ch.eof ? st.lines.length : cursor;
        st.lines.splice(ins, 0, ...n.map((e) => e.text));
        cursor = ins + n.length;
      } else {
        const found = findTierFrom(st.lines, o, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        const repl = buildReplacement(st.lines, pos, o, n, found.tier);
        st.lines.splice(pos, o.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const text = joinFile(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
