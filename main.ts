// main.ts -- mend, the command-line tool SPEC.md specifies.
//
// mend applies an edit an AI model wrote, in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON tool-call edits), to the tree of text files the
// working directory holds. It finds the lines each edit names at the first of three
// matching tiers (exact, trailing whitespace, leading and trailing whitespace), and
// writes every change or none, printing what it changed or why it failed.
//
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this
// file hands over to runner.ts: keep that hand-over and runner.ts as they are.

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

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed each. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** Shared state for one run: --strict, and the move pairs edits recorded. */
interface Cx {
  strict: boolean;
  moves: Array<[string, string]>;
}

/** A file's lines under SPEC.md section 3: its break, its lines, whether it ends with a break. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions where O occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
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

/**
 * The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or
 * after `from`, with every such position. Empty O never matches: callers insert it.
 */
function findMatch(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  if (o.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrences(lines, o, tier).filter((p) => p >= from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/**
 * The lines N writes when it replaces O at position pos. `ctx` maps each index of N
 * to the index of the O line it is a context copy of, or -1 for a fresh (`+`) line.
 * A context line is written as the file's own matched line, never the patch's. At
 * tier 2 a fresh line is re-indented: F is the leading spaces and tabs of the file's
 * first matched line, P those of O's first line; a fresh line that is not empty and
 * not only whitespace, and starts with P, has that P replaced by F.
 */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: string[], ctx: number[], tier: number): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = o.length > 0 ? leadWs(fileLines[pos]!) : '';
  for (let k = 0; k < n.length; k++) {
    if (ctx[k]! >= 0) {
      out.push(fileLines[pos + ctx[k]!]!);
      continue;
    }
    let line = n[k]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
    out.push(line);
  }
  return out;
}

/** Split a hunk or chunk body into its old lines O, new lines N, and N's context map. */
function bodyON(body: BodyLine[]): { o: string[]; n: string[]; ctx: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: number[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      ctx.push(o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      ctx.push(-1);
      n.push(b.text);
    }
  }
  return { o, n, ctx };
}

/** One body line of a unified hunk or a V4A chunk. `bare` marks a literally empty line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
  bare?: boolean;
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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
  noEol: boolean;
}

interface UniSection {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path of a `--- ` or `+++ ` header line: after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Apply a section's hunks in order to a file's text; `path` names the file for failures. */
function applyHunks(text: string, hunks: Hunk[], cx: Cx, path: string): string {
  const m = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n, ctx } = bodyON(h.body);
    if (o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, m.lines.length));
      const atEnd = pos === m.lines.length;
      m.lines.splice(pos, 0, ...n);
      if (atEnd) m.final = !h.noEol;
      d += n.length;
      continue;
    }
    const found = findMatch(m.lines, o, cx.strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const rep = buildReplacement(m.lines, best, o, n, ctx, found.tier);
    const atEnd = best + o.length === m.lines.length;
    m.lines.splice(best, o.length, ...rep);
    if (atEnd) m.final = !h.noEol;
    d += n.length - o.length;
  }
  return joinFile(m);
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let pairOld: string | undefined;
  let pairNew: string | undefined;
  let hasPair = false;
  let loneNew: string | undefined;
  let renameOld: string | undefined;
  let renameNew: string | undefined;
  let diffOld = '';
  let diffNew = '';
  let create = false;
  let del = false;
  let hunk: Hunk | null = null;
  let state: 'outside' | 'header' | 'body' | 'after' = 'outside';

  const endHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0) {
      const last = hunk.body[hunk.body.length - 1]!;
      if (last.kind === 'ctx' && last.bare === true) hunk.body.pop();
      else break;
    }
    hunk.noEol = false;
    for (let k = hunk.body.length - 1; k >= 0; k--) {
      const b = hunk.body[k]!;
      if (b.kind === 'ctx' || b.kind === 'new') {
        if (hunk.body[k + 1] !== undefined && hunk.body[k + 1]!.kind === 'back') hunk.noEol = true;
        break;
      }
    }
    cur!.hunks.push(hunk);
    hunk = null;
    state = 'after';
  };

  const endSection = (): void => {
    if (cur === null) return;
    endHunk();
    const oldPath = hasPair ? pairOld! : (renameOld ?? diffOld);
    const newPath = hasPair ? pairNew! : (renameNew ?? loneNew ?? diffNew);
    cur.oldPath = oldPath;
    cur.newPath = newPath;
    cur.create = create;
    cur.del = del;
    sections.push(cur);
    cur = null;
    state = 'outside';
  };

  const startSection = (dOld: string, dNew: string): void => {
    endSection();
    cur = { oldPath: null, newPath: null, create: false, del: false, hunks: [] };
    pairOld = undefined;
    pairNew = undefined;
    hasPair = false;
    loneNew = undefined;
    renameOld = undefined;
    renameNew = undefined;
    diffOld = dOld;
    diffNew = dNew;
    create = false;
    del = false;
    hunk = null;
    state = 'header';
  };

  /** A `--- ` line followed by a `+++ ` line starts a section; consume both lines. */
  const startAtPair = (i: number): number => {
    startSection('', '');
    pairOld = headerPath(lines[i]!);
    pairNew = headerPath(lines[i + 1]!);
    hasPair = true;
    return i + 1;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        endHunk();
        const m = DIFF_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(m[1]!, m[2]!);
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endHunk();
        i = startAtPair(i);
        i++;
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        const b = hunk!.body;
        if (line === '') b.push({ kind: 'ctx', text: '', bare: true });
        else if (line.startsWith(' ')) b.push({ kind: 'ctx', text: line.slice(1) });
        else if (line.startsWith('-')) b.push({ kind: 'old', text: line.slice(1) });
        else if (line.startsWith('+')) b.push({ kind: 'new', text: line.slice(1) });
        else b.push({ kind: 'back', text: line });
        i++;
        continue;
      }
      endHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseInt(m[1]!, 10), body: [], noEol: false };
      state = 'body';
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && state === 'header') {
        pairOld = headerPath(line);
        pairNew = headerPath(lines[i + 1]!);
        hasPair = true;
        i += 2;
        continue;
      }
      // A `--- ` line followed by a `+++ ` line starts a section, in the open or after a hunk.
      i = startAtPair(i);
      i++;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) loneNew = headerPath(line);
      else if (line.startsWith('rename from ')) renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) create = true;
      else if (line.startsWith('deleted file mode')) del = true;
      i++;
      continue;
    }
    i++;
  }
  endSection();
  return sections;
}

function applyUnifiedSection(sec: UniSection, tree: Tree, cx: Cx): void {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  // Every path the edit names is checked for safety before anything else about it.
  if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
  if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
  if (oldP === null || sec.create) {
    if (newP === null) throw new Fail('unsafe', '/dev/null');
    if (tree.get(newP) !== null) throw new Fail('exists', newP);
    const plus: string[] = [];
    let lastPlus: { h: Hunk; k: number } | null = null;
    for (const h of sec.hunks) {
      for (let k = 0; k < h.body.length; k++) {
        if (h.body[k]!.kind === 'new') {
          plus.push(h.body[k]!.text);
          lastPlus = { h, k };
        }
      }
    }
    const noEol = lastPlus !== null && lastPlus.h.body[lastPlus.k + 1] !== undefined && lastPlus.h.body[lastPlus.k + 1]!.kind === 'back';
    tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    return;
  }
  if (newP === null || sec.del) {
    if (oldP === null) throw new Fail('missing', '/dev/null');
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, null);
    return;
  }
  const text = tree.get(oldP);
  if (text === null) throw new Fail('missing', oldP);
  const isMove = oldP !== newP;
  if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
  const out = applyHunks(text, sec.hunks, cx, oldP);
  if (isMove) {
    tree.now.set(oldP, null);
    tree.now.set(newP, out);
    cx.moves.push([oldP, newP]);
  } else {
    tree.now.set(oldP, out);
  }
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let sep = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, sep), newLines: lines.slice(sep + 1, rep) });
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return blocks;
}

function applySRBlock(b: SRBlock, tree: Tree, cx: Cx): void {
  if (!safe(b.path)) throw new Fail('unsafe', b.path);
  if (b.oldLines.length === 0) {
    if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
    tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
    return;
  }
  const text = tree.get(b.path);
  if (text === null) throw new Fail('missing', b.path);
  const m = splitFile(text);
  const found = findMatch(m.lines, b.oldLines, cx.strict);
  if (found === null) throw new Fail('no-match', b.path);
  if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
  const pos = found.pos[0]!;
  const ctx = b.newLines.map(() => -1);
  const rep = buildReplacement(m.lines, pos, b.oldLines, b.newLines, ctx, found.tier);
  m.lines.splice(pos, b.oldLines.length, ...rep);
  tree.now.set(b.path, joinFile(m));
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  o: string[];
  n: string[];
  ctx: number[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  lines?: string[];
  moveTo?: string | null;
  chunks?: VChunk[];
  lineNo: number;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'del' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    const secLines: { text: string; no: number }[] = [];
    i++;
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      secLines.push({ text: l, no: i + 1 });
      i++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const sl of secLines) {
        if (sl.text === '') fileLines.push('');
        else if (sl.text.startsWith('+')) fileLines.push(sl.text.slice(1));
        else throw new Exit2(`error: parse ${sl.no}`);
      }
      sections.push({ kind, path, lines: fileLines, lineNo: headerLine });
    } else if (kind === 'del') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.no}`);
      sections.push({ kind, path, lineNo: headerLine });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.text.slice(13).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const pushCur = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; idx < secLines.length; idx++) {
        const sl = secLines[idx]!;
        const t = sl.text;
        if (t.startsWith('@@')) {
          pushCur();
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], ctx: [], eof: false };
        } else if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${sl.no}`);
          cur.eof = true;
          pushCur();
        } else if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (cur === null) cur = { anchor: null, o: [], n: [], ctx: [], eof: false };
          if (t === '') {
            cur.ctx.push(cur.o.length);
            cur.o.push('');
            cur.n.push('');
          } else if (t.startsWith(' ')) {
            cur.ctx.push(cur.o.length);
            cur.o.push(t.slice(1));
            cur.n.push(t.slice(1));
          } else if (t.startsWith('-')) {
            cur.o.push(t.slice(1));
          } else {
            cur.ctx.push(-1);
            cur.n.push(t.slice(1));
          }
        } else {
          throw new Exit2(`error: parse ${sl.no}`);
        }
      }
      pushCur();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, moveTo, chunks, lineNo: headerLine });
    }
  }
  return sections;
}

function applyV4aSection(sec: VSection, tree: Tree, cx: Cx): void {
  if (sec.kind === 'add') {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
    const ls = sec.lines!;
    tree.now.set(sec.path, ls.length === 0 ? '' : ls.join('\n') + '\n');
    return;
  }
  if (sec.kind === 'del') {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
    tree.now.set(sec.path, null);
    return;
  }
  if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
  if (sec.moveTo !== null && sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
  const text = tree.get(sec.path);
  if (text === null) throw new Fail('missing', sec.path);
  if (sec.moveTo !== null && sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
  const m = splitFile(text);
  let cursor = 0;
  for (const ch of sec.chunks!) {
    if (ch.anchor !== null) {
      const found = findMatch(m.lines, [ch.anchor], cx.strict, cursor);
      if (found === null) throw new Fail('no-match', sec.path);
      cursor = found.pos[0]! + 1;
    }
    if (ch.o.length === 0) {
      const pos = ch.eof ? m.lines.length : cursor;
      m.lines.splice(pos, 0, ...ch.n);
      cursor = pos + ch.n.length;
    } else {
      const found = findMatch(m.lines, ch.o, cx.strict, cursor);
      if (found === null) throw new Fail('no-match', sec.path);
      let pos: number | undefined;
      for (const p of found.pos) {
        if (ch.eof && p + ch.o.length !== m.lines.length) continue;
        pos = p;
        break;
      }
      if (pos === undefined) throw new Fail('no-match', sec.path);
      const rep = buildReplacement(m.lines, pos, ch.o, ch.n, ch.ctx, found.tier);
      m.lines.splice(pos, ch.o.length, ...rep);
      cursor = pos + rep.length;
    }
  }
  const out = joinFile(m);
  if (sec.moveTo !== null && sec.moveTo !== undefined) {
    tree.now.set(sec.path, null);
    tree.now.set(sec.moveTo, out);
    cx.moves.push([sec.path, sec.moveTo]);
  } else {
    tree.now.set(sec.path, out);
  }
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC.md sections 1, 2 and 10)                      */
/* ------------------------------------------------------------------ */

function readEdits(kind: string, text: string, lines: string[], cx: Cx): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return parseUnified(lines).map((s) => (tree: Tree) => applyUnifiedSection(s, tree, cx));
  if (kind === 'search-replace') return parseSearchReplace(lines).map((b) => (tree: Tree) => applySRBlock(b, tree, cx));
  return parseV4a(lines).map((s) => (tree: Tree) => applyV4aSection(s, tree, cx));
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
  const cx: Cx = { strict, moves: [] };
  let edits: Edit[];
  try {
    edits = readEdits(kind, text, lines, cx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move that succeeded replaces its pair's D and A lines with one R line, sorted by the new path.
  const covered = new Set<string>();
  const rRows = new Map<string, string>();
  for (const [oldP, newP] of cx.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rRows.set(newP, `R ${oldP} -> ${newP}`);
      covered.add(oldP);
      covered.add(newP);
    }
  }
  const rows: string[] = [];
  const rowKeys: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!covered.has(p)) {
      rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
      rowKeys.push(p);
    }
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const all: Array<[string, string]> = rows.map((r, i) => [rowKeys[i]!, r] as [string, string]);
  for (const [k, v] of rRows) all.push([k, v]);
  all.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  const outRows = all.map(([, r]) => r);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
