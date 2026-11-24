// main.ts is mend, the CLI SPEC.md specifies. Sections 1 to 10: the command line and report, safe paths,
// format detection, all four patch formats, the three matching tiers, and the all-or-nothing write.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): that hand-over and runner.ts stay as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A fault that ends the run with exit 2 and one line, before any file is looked at. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's refusal: a code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: not empty, not absolute, no backslash, no empty / . / .. segment. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new], for the `R` line of the report. */
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

/** Section 4: the first format that holds, or null. */
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

/* ---------------------------------------------------------------------------
 * Sections 3 and 5: a file's lines, and the three matching tiers.
 * ------------------------------------------------------------------------- */

/** A file split into lines, remembering its break and whether it ended with one. */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

const exact = (s: string): string => s;
const noTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const noEdges = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const TIERS = [exact, noTrailing, noEdges];

/** Byte order of two paths, UTF-8, without needing Buffer's typings. */
function cmpBytes(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

/** `--strict` tries tier 0 alone; otherwise all three. */
const tierCount = (strict: boolean): number => (strict ? 1 : 3);

/** Every position where O sits in `lines` at one tier. Occurrences may overlap. */
function positionsAt(lines: string[], o: string[], tier: number): number[] {
  const f = TIERS[tier]!;
  const want = o.map(f);
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (f(lines[i + k]!) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with every occurrence there. */
function firstTier(lines: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  const n = tierCount(strict);
  for (let t = 0; t < n; t++) {
    const at = positionsAt(lines, o, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** The leading spaces and tabs of a line. */
function indentOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line of a patch's new side: either the file's own matched line, or a literal. */
interface NLine {
  /** 'ctx' takes the file's line at `src`; 'lit' writes `s`. */
  k: 'ctx' | 'lit';
  src: number;
  s: string;
}

/** One side of a hunk body. */
interface Part {
  t: 'ctx' | 'old' | 'new';
  s: string;
}

/**
 * The lines a hunk writes. Context lines come from the file, never the patch.
 * At tier 2 every other line has O's leading whitespace swapped for the
 * matched line's, so a patch that lost its indentation lands back in the block.
 */
function renderLines(n: NLine[], fileLines: string[], at: number, tier: number, oFirst: string): string[] {
  const p = indentOf(oFirst);
  const f = indentOf(fileLines[at] ?? '');
  return n.map((line) => {
    if (line.k === 'ctx') return fileLines[at + line.src]!;
    if (tier === 2 && line.s !== '' && line.s.trim() !== '' && line.s.startsWith(p)) return f + line.s.slice(p.length);
    return line.s;
  });
}

/** Split O and N out of a hunk body, keeping which new lines are context. */
function splitBody(parts: Part[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const part of parts) {
    if (part.t === 'ctx') {
      n.push({ k: 'ctx', src: o.length, s: part.s });
      o.push(part.s);
    } else if (part.t === 'old') {
      o.push(part.s);
    } else {
      n.push({ k: 'lit', src: -1, s: part.s });
    }
  }
  return { o, n };
}

/* ---------------------------------------------------------------------------
 * Section 6: unified diffs.
 * ------------------------------------------------------------------------- */

interface Hunk {
  /** The `@@ -A ...` start line number, 1-based. */
  a: number;
  parts: Part[];
  /** The body's raw lines, for the `\` line rule. */
  raw: string[];
}

/** The text after the four characters of a `--- ` / `+++ ` line, to the first tab, trimmed. */
function headerPath(s: string): string {
  return s.split('\t')[0]!.trim();
}

function dropPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** True when a `\` line follows the last context or `+` line of this body. */
function endsWithoutBreak(raw: string[]): boolean {
  let last = -1;
  for (let x = 0; x < raw.length; x++) {
    const b = raw[x]!;
    if (b === '' || b[0] === ' ' || b[0] === '+') last = x;
  }
  return last >= 0 && (raw[last + 1] ?? '').startsWith('\\');
}

/**
 * Apply a unified section's hunks to a document, in order, each to the result
 * of the ones before it. `d` is the running change in line count, which is what
 * lets a diff whose line numbers drifted still land.
 */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  const cur = doc.lines.slice();
  let fin = doc.final;
  let d = 0;
  for (const hunk of hunks) {
    const { o, n } = splitBody(hunk.parts);
    const delta = n.length - o.length;
    if (o.length === 0) {
      const before = cur.length;
      const at = Math.min(hunk.a + d, before);
      cur.splice(at, 0, ...n.map((line) => line.s));
      if (at === before) fin = !endsWithoutBreak(hunk.raw);
      d += delta;
      continue;
    }
    const found = firstTier(cur, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const want = hunk.a - 1 + d;
    let at = found.at[0]!;
    for (const p of found.at) if (Math.abs(p - want) < Math.abs(at - want)) at = p;
    const before = cur.length;
    const written = renderLines(n, cur, at, found.tier, o[0]!);
    cur.splice(at, o.length, ...written);
    if (at + o.length === before) fin = !endsWithoutBreak(hunk.raw);
    d += delta;
  }
  return { lines: cur, br: doc.br, final: fin };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i]!;
    let gitOld: string | null = null;
    let gitNew: string | null = null;
    let from = i;
    if (head.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(head);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      gitOld = m[1]!;
      gitNew = m[2]!;
      from = i + 1;
    } else if (!(head.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      if (head.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }

    let oldPath: string | null | undefined;
    let newPath: string | null | undefined;
    let makes = false;
    let deletes = false;
    let j = from;
    while (j < lines.length) {
      const h = lines[j]!;
      if (h.startsWith('@@')) break;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ')) {
        if (!(lines[j + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${j + 2}`);
        const op = headerPath(h.slice(4));
        const np = headerPath((lines[j + 1] ?? '').slice(4));
        oldPath = op === '/dev/null' ? null : dropPrefix(op);
        newPath = np === '/dev/null' ? null : dropPrefix(np);
        j += 2;
        continue;
      }
      if (h.startsWith('rename from ')) oldPath = h.slice(12).trim();
      else if (h.startsWith('rename to ')) newPath = h.slice(10).trim();
      else if (h.startsWith('new file mode')) makes = true;
      else if (h.startsWith('deleted file mode')) deletes = true;
      j += 1;
    }

    const hunks: Hunk[] = [];
    while (j < lines.length && lines[j]!.startsWith('@@')) {
      const m = HUNK_HEAD.exec(lines[j]!);
      if (m === null) throw new Exit2(`error: parse ${j + 1}`);
      const a = Number(m[1]);
      const raw: string[] = [];
      let k = j + 1;
      while (k < lines.length) {
        const b = lines[k]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
        const c = b[0];
        if (b === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
          raw.push(b);
          k += 1;
          continue;
        }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const parts: Part[] = [];
      for (const b of raw) {
        if (b[0] === '\\') continue;
        const c = b[0];
        if (b === '') parts.push({ t: 'ctx', s: '' });
        else if (c === ' ') parts.push({ t: 'ctx', s: b.slice(1) });
        else if (c === '-') parts.push({ t: 'old', s: b.slice(1) });
        else parts.push({ t: 'new', s: b.slice(1) });
      }
      hunks.push({ a, parts, raw });
      j = k;
    }

    const oldP = oldPath !== undefined ? oldPath : gitOld === null ? null : dropPrefix(gitOld);
    const newP = newPath !== undefined ? newPath : gitNew === null ? null : dropPrefix(gitNew);
    const kind = oldP === null || makes ? 'create' : newP === null || deletes ? 'delete' : oldP !== newP ? 'move' : 'change';

    if (kind === 'create') {
      const p = newP!;
      const out: string[] = [];
      for (const h of hunks) for (const part of h.parts) if (part.t === 'new') out.push(part.s);
      const noBreak = hunks.length > 0 && endsWithoutBreak(hunks[hunks.length - 1]!.raw);
      const text = out.length === 0 ? '' : out.join('\n') + (noBreak ? '' : '\n');
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      });
      i = j;
      continue;
    }

    if (kind === 'delete') {
      const p = oldP!;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
      continue;
    }

    const src = oldP!;
    const dst = kind === 'move' ? newP! : src;
    edits.push((tree) => {
      if (!safe(src)) throw new Fail('unsafe', src);
      if (kind === 'move' && !safe(dst)) throw new Fail('unsafe', dst);
      const was = tree.get(src);
      if (was === null) throw new Fail('missing', src);
      if (kind === 'move' && tree.get(dst) !== null) throw new Fail('exists', dst);
      const out = applyHunks(parseDoc(was), hunks, strict, src);
      tree.now.set(dst, writeDoc(out));
      if (kind === 'move') {
        tree.now.set(src, null);
        tree.moves.push([src, dst]);
      }
    });
    i = j;
  }
  return edits;
}

/* ---------------------------------------------------------------------------
 * Section 7: SEARCH/REPLACE blocks.
 * ------------------------------------------------------------------------- */

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_SPLIT = '=======';
const SR_END = '>>>>>>> REPLACE';

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let afterLast = 0;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== SR_SEARCH) {
      i += 1;
      continue;
    }
    const searchLine = i;
    let k = i + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== SR_SPLIT && lines[k]!.trimEnd() !== SR_END) k += 1;
    if (k >= lines.length || lines[k]!.trimEnd() !== SR_SPLIT) throw new Exit2(`error: parse ${searchLine + 1}`);
    const split = k;
    let end = split + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== SR_END) end += 1;
    if (end >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);

    let path: string | null = null;
    for (let x = searchLine - 1; x >= afterLast; x--) {
      const t = lines[x]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);

    const oldLines = lines.slice(searchLine + 1, split);
    const newLines = lines.slice(split + 1, end);
    const p = path;

    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const was = tree.get(p);
      if (was === null) throw new Fail('missing', p);
      const doc = parseDoc(was);
      const found = firstTier(doc.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const at = found.at[0]!;
      const written = renderLines(
        newLines.map((s) => ({ k: 'lit' as const, src: -1, s })),
        doc.lines,
        at,
        found.tier,
        oldLines[0]!,
      );
      doc.lines.splice(at, oldLines.length, ...written);
      tree.now.set(p, writeDoc(doc));
    });

    afterLast = end + 1;
    lastPath = path;
    i = end + 1;
  }
  return edits;
}

/* ---------------------------------------------------------------------------
 * Section 8: V4A patches.
 * ------------------------------------------------------------------------- */

interface Chunk {
  anchor: string | null;
  parts: Part[];
  eof: boolean;
}

function isV4aSection(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

/** Apply an Update File section's chunks, each with its own cursor. */
function applyChunks(doc: Doc, chunks: Chunk[], strict: boolean, path: string): Doc {
  const cur = doc.lines.slice();
  const n = tierCount(strict);
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      let at = -1;
      for (let t = 0; t < n && at < 0; t++) {
        const f = TIERS[t]!;
        const want = f(chunk.anchor);
        for (let x = cursor; x < cur.length; x++) {
          if (f(cur[x]!) === want) {
            at = x;
            break;
          }
        }
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const { o, n: written } = splitBody(chunk.parts);
    if (o.length === 0) {
      const at = chunk.eof ? cur.length : cursor;
      const lines = written.map((line) => line.s);
      cur.splice(at, 0, ...lines);
      cursor = at + lines.length;
      continue;
    }
    let at = -1;
    let tier = -1;
    for (let t = 0; t < n && at < 0; t++) {
      const f = TIERS[t]!;
      for (let x = cursor; x + o.length <= cur.length; x++) {
        let ok = true;
        for (let k = 0; k < o.length; k++) {
          if (f(cur[x + k]!) !== f(o[k]!)) {
            ok = false;
            break;
          }
        }
        if (ok && (!chunk.eof || x + o.length === cur.length)) {
          at = x;
          tier = t;
          break;
        }
      }
    }
    if (at < 0) throw new Fail('no-match', path);
    const lines = renderLines(written, cur, at, tier, o[0]!);
    cur.splice(at, o.length, ...lines);
    cursor = at + lines.length;
  }
  return { lines: cur, br: doc.br, final: doc.final };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let x = lines.length - 1; x >= 0; x--) {
    if (!blank(lines[x]!)) {
      last = x;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const head = lines[i]!;
    if (blank(head)) {
      i += 1;
      continue;
    }

    if (head.startsWith('*** Add File: ')) {
      const p = head.slice(14).trim();
      const body: string[] = [];
      let j = i + 1;
      while (j < last) {
        const b = lines[j]!;
        if (isV4aSection(b) || b.trim() === '*** End Patch') break;
        if (b === '') body.push('');
        else if (b[0] === '+') body.push(b.slice(1));
        else throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const text = body.length === 0 ? '' : body.join('\n') + '\n';
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, text);
      });
      i = j;
      continue;
    }

    if (head.startsWith('*** Delete File: ')) {
      const p = head.slice(17).trim();
      let j = i + 1;
      while (j < last) {
        const b = lines[j]!;
        if (isV4aSection(b) || b.trim() === '*** End Patch') break;
        if (!blank(b)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
      continue;
    }

    if (head.startsWith('*** Update File: ')) {
      const p = head.slice(17).trim();
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice(13).trim();
        j += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      const open = (anchor: string | null): Chunk => {
        const chunk: Chunk = { anchor, parts: [], eof: false };
        chunks.push(chunk);
        cur = chunk;
        return chunk;
      };
      for (; j < last; j++) {
        const b = lines[j]!;
        if (isV4aSection(b) || b.trim() === '*** End Patch') break;
        if (b.trim() === '*** End of File') {
          (cur ?? open(null)).eof = true;
          continue;
        }
        if (b.startsWith('@@')) {
          const anchor = b.slice(2).trim();
          open(anchor === '' ? null : anchor);
          continue;
        }
        const c = b[0];
        if (b === '') (cur ?? open(null)).parts.push({ t: 'ctx', s: '' });
        else if (c === ' ') (cur ?? open(null)).parts.push({ t: 'ctx', s: b.slice(1) });
        else if (c === '-') (cur ?? open(null)).parts.push({ t: 'old', s: b.slice(1) });
        else if (c === '+') (cur ?? open(null)).parts.push({ t: 'new', s: b.slice(1) });
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      for (const chunk of chunks) {
        while (chunk.parts.length > 0) {
          const tail = chunk.parts[chunk.parts.length - 1]!;
          if (tail.t !== 'ctx' || tail.s !== '') break;
          chunk.parts.pop();
        }
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const was = tree.get(p);
        if (was === null) throw new Fail('missing', p);
        const dst = moveTo ?? p;
        if (moveTo !== null && tree.get(dst) !== null) throw new Fail('exists', dst);
        const out = applyChunks(parseDoc(was), chunks, strict, p);
        tree.now.set(dst, writeDoc(out));
        if (moveTo !== null) {
          tree.now.set(p, null);
          tree.moves.push([p, dst]);
        }
      });
      i = j;
      continue;
    }

    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ---------------------------------------------------------------------------
 * Section 9: JSON edits.
 * ------------------------------------------------------------------------- */

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
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------------------------------------------------------------------
 * Sections 1, 2 and 10: the command line, the report, and the write.
 * ------------------------------------------------------------------------- */

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
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

  // A move prints as one R line, replacing its D and A pair, and sorts by its new path.
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const [a, b] of tree.moves) {
    if (tree.original(a) !== null && tree.now.get(a) === null && tree.original(b) === null && tree.now.get(b) !== null) {
      movedFrom.add(a);
      movedTo.add(b);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [a, b] of tree.moves) {
    if (!movedFrom.has(a) || !movedTo.has(b)) continue;
    rows.push({ key: b, line: `R ${a} -> ${b}` });
  }
  rows.sort((x, y) => cmpBytes(x.key, y.key));

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
