// The reading view of one changed file: the agent picks which lines of the
// patch to hide, and this module renders the result from the untouched patch.
//
// The agent never writes diff text. It submits a plan in the patch's own line
// numbers: remove whole lines, fold a run of same-kind lines into one "..."
// row, or elide part of one line with "..." while keeping every other
// character. Every visible row is therefore either a verbatim patch line or a
// patch line with visible "..." gaps, so the agent can choose what the owner
// skips but never what the remaining code says.
//
// Two rules sit outside the agent's control:
// - C# `using` directives are hidden automatically, as scaffolding.
// - A line that a finding cites is never hidden or elided, by the agent or by
//   the automatic rule. The owner decides on the findings, so their evidence
//   stays on screen.
//
// Hidden lines are not dropped: they come back as gap rows, so the viewer can
// count them and expand them in place.

export type LineRange = { start_line: number; end_line: number };
export type LineReplacement = { line: number; old: string; new: string };
export type ReadingPlan = {
  remove: LineRange[];
  fold: LineRange[];
  replace: LineReplacement[];
};

type SourceKind = "add" | "del" | "ctx";
type PatchLine =
  | { kind: "hunk"; text: string }
  | { kind: "eof"; text: string }
  | { kind: SourceKind; text: string; old: number | null; new: number | null };

/** Why a run of lines is hidden: the agent removed it, or the automatic rule did. */
export type GapReason = "removed" | "using";

export type ReadingRow =
  | { kind: "hunk"; line: number; text: string }
  | { kind: "eof"; line: number; text: string }
  | {
      kind: SourceKind;
      line: number;
      text: string;
      old: number | null;
      new: number | null;
      elided: boolean;
    }
  | {
      kind: "fold";
      sign: SourceKind;
      indent: string;
      start_line: number;
      end_line: number;
    }
  | { kind: "gap"; reason: GapReason; start_line: number; end_line: number };

export type ReadingStats = {
  /** Added and deleted lines in the patch. */
  changed: number;
  /** Added and deleted lines still shown verbatim or elided. */
  visibleChanged: number;
  removedChanged: number;
  foldedChanged: number;
  usingChanged: number;
  folds: number;
};

export type ReadingResult =
  | { ok: true; rows: ReadingRow[]; stats: ReadingStats }
  | { ok: false; problems: string[] };

export type ReadingOptions = {
  /** The changed file's path, which decides the automatic language rules. */
  path: string;
  /** New-side line numbers that findings cite. These always stay visible. */
  protectedLines?: Iterable<number>;
};

const EMPTY_PLAN: ReadingPlan = { remove: [], fold: [], replace: [] };
const MAX_REPLACEMENT_CHARS = 4_000;

/** Splits a GitHub file patch (hunks only, no file headers) into typed lines. */
export function patchLines(patch: string): PatchLine[] {
  const raw = patch.split("\n");
  if (raw.at(-1) === "") raw.pop();
  const out: PatchLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const text of raw) {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: "hunk", text });
    } else if (text.startsWith("\\")) out.push({ kind: "eof", text });
    else if (text.startsWith("+"))
      out.push({ kind: "add", text: text.slice(1), old: null, new: newNo++ });
    else if (text.startsWith("-"))
      out.push({ kind: "del", text: text.slice(1), old: oldNo++, new: null });
    else
      out.push({
        kind: "ctx",
        text: text.slice(1),
        old: oldNo++,
        new: newNo++,
      });
  }
  return out;
}

/** The patch with a 1-based `N|` gutter, as the agent sees it. */
export function numberedPatch(patch: string): string {
  const raw = patch.split("\n");
  if (raw.at(-1) === "") raw.pop();
  return raw.map((text, i) => `${i + 1}|${text}`).join("\n");
}

// A using directive, not a using statement or declaration: `using X.Y;`,
// `using static X.Y;`, `using A = X.Y<Z>;`, `global using X;`.
const CS_USING =
  /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_][\w]*\s*=\s*)?[A-Za-z_][\w.]*(?:<[\w.,\s<>]*>)?\s*;\s*(?:\/\/.*)?$/;

/** Marks the source lines the automatic rule hides for this file. */
export function automaticHidden(path: string, lines: PatchLine[]): boolean[] {
  const csharp = /\.cs$/i.test(path);
  return lines.map(
    (l) => csharp && l.kind !== "hunk" && l.kind !== "eof" && CS_USING.test(l.text),
  );
}

/**
 * Checks a reading plan against the patch and renders it. On any problem the
 * whole plan is refused with every problem listed, so the agent can fix them
 * in one retry.
 */
export function compileReadingPlan(
  patch: string,
  plan: ReadingPlan = EMPTY_PLAN,
  options: ReadingOptions,
): ReadingResult {
  const lines = patchLines(patch);
  const n = lines.length;
  const problems: string[] = [];
  const protectedNew = new Set(options.protectedLines ?? []);
  const isProtected = (i: number) => {
    const l = lines[i]!;
    return l.kind !== "hunk" && l.kind !== "eof" && l.new !== null && protectedNew.has(l.new);
  };
  const auto = automaticHidden(options.path, lines).map(
    (hidden, i) => hidden && !isProtected(i),
  );
  const removed = Array.from({ length: n }, (): boolean => false);
  const foldAt = Array.from({ length: n }, (): number => -1);
  const folds: Extract<ReadingRow, { kind: "fold" }>[] = [];

  const inBounds = (label: string, r: LineRange) => {
    if (!Number.isInteger(r.start_line) || !Number.isInteger(r.end_line) || r.start_line < 1 || r.start_line > r.end_line) {
      problems.push(`${label}: ${r.start_line}-${r.end_line} is not an inclusive 1-based range.`);
      return false;
    }
    if (r.end_line > n) {
      problems.push(`${label}: line ${r.end_line} is past the end of the patch (${n} lines).`);
      return false;
    }
    return true;
  };
  const protectedIn = (start: number, end: number) => {
    for (let i = start - 1; i < end; i++) if (isProtected(i)) return i + 1;
    return 0;
  };

  plan.remove.forEach((r, k) => {
    const label = `remove[${k}]`;
    if (!inBounds(label, r)) return;
    const cited = protectedIn(r.start_line, r.end_line);
    if (cited) {
      problems.push(`${label}: line ${cited} is cited by a finding and must stay visible.`);
      return;
    }
    for (let i = r.start_line - 1; i < r.end_line; i++) {
      if (removed[i]) {
        problems.push(`${label}: overlaps an earlier remove at line ${i + 1}.`);
        return;
      }
    }
    for (let i = r.start_line - 1; i < r.end_line; i++) removed[i] = true;
  });

  plan.fold.forEach((r, k) => {
    const label = `fold[${k}]`;
    if (!inBounds(label, r)) return;
    if (r.end_line - r.start_line < 1) {
      problems.push(`${label}: a fold needs at least two lines; use remove for one.`);
      return;
    }
    const first = lines[r.start_line - 1]!;
    const sign = first.kind;
    if (sign === "hunk" || sign === "eof") {
      problems.push(`${label}: line ${r.start_line} is not a source line.`);
      return;
    }
    const texts: string[] = [];
    let autoCount = 0;
    for (let i = r.start_line - 1; i < r.end_line; i++) {
      const l = lines[i]!;
      if (l.kind !== sign) {
        problems.push(`${label}: line ${i + 1} is not a ${sign} line like line ${r.start_line}; a fold covers one kind of line inside one hunk.`);
        return;
      }
      if (removed[i] || foldAt[i] >= 0) {
        problems.push(`${label}: overlaps a ${removed[i] ? "remove" : "fold"} at line ${i + 1}.`);
        return;
      }
      if (auto[i]) autoCount++;
      texts.push(l.text);
    }
    const length = r.end_line - r.start_line + 1;
    if (autoCount === length) return; // Already hidden; nothing to fold.
    if (autoCount > 0) {
      problems.push(`${label}: mixes using directives, which are hidden automatically, with other lines; fold only the other lines.`);
      return;
    }
    const cited = protectedIn(r.start_line, r.end_line);
    if (cited) {
      problems.push(`${label}: line ${cited} is cited by a finding and must stay visible.`);
      return;
    }
    const index = folds.length;
    folds.push({
      kind: "fold",
      sign,
      indent: commonIndent(texts),
      start_line: r.start_line,
      end_line: r.end_line,
    });
    for (let i = r.start_line - 1; i < r.end_line; i++) foldAt[i] = index;
  });

  const elisions = new Map<number, { start: number; end: number; new: string }[]>();
  plan.replace.forEach((r, k) => {
    const label = `replace[${k}]`;
    if (!Number.isInteger(r.line) || r.line < 1 || r.line > n) {
      problems.push(`${label}: line ${r.line} is outside the patch (1-${n}).`);
      return;
    }
    const i = r.line - 1;
    const l = lines[i]!;
    if (l.kind === "hunk" || l.kind === "eof") {
      problems.push(`${label}: line ${r.line} is not a source line.`);
      return;
    }
    if (auto[i]) return; // Already hidden; the elision is moot.
    if (removed[i] || foldAt[i] >= 0) {
      problems.push(`${label}: line ${r.line} is also ${removed[i] ? "removed" : "folded"}.`);
      return;
    }
    if (isProtected(i)) {
      problems.push(`${label}: line ${r.line} is cited by a finding and must stay verbatim.`);
      return;
    }
    if (r.old.length > MAX_REPLACEMENT_CHARS || r.new.length > MAX_REPLACEMENT_CHARS || /[\r\n]/.test(r.old + r.new)) {
      problems.push(`${label}: old and new must each be one line under ${MAX_REPLACEMENT_CHARS} characters.`);
      return;
    }
    if (r.old === "" || r.new === r.old) {
      problems.push(`${label}: old must be non-empty and new must elide part of it.`);
      return;
    }
    const start = l.text.indexOf(r.old);
    if (start < 0 || l.text.indexOf(r.old, start + 1) >= 0) {
      problems.push(`${label}: old must occur exactly once on line ${r.line}, after the +, - or space marker.`);
      return;
    }
    if (!isElision(r.old, r.new)) {
      problems.push(`${label}: new must keep every character of old except spans replaced by ... or …, and each ... must stand for at least one character.`);
      return;
    }
    const spans = elisions.get(i) ?? [];
    if (spans.some((s) => start < s.end && s.start < start + r.old.length)) {
      problems.push(`${label}: overlaps another replace on line ${r.line}.`);
      return;
    }
    spans.push({ start, end: start + r.old.length, new: r.new });
    elisions.set(i, spans);
  });

  // A hunk header is the compiler's: shown while any line in its hunk is,
  // hidden with the hunk. Removing it while keeping the hunk is refused.
  const hidden = (i: number) => removed[i] || auto[i];
  let hunkStart = -1;
  const hunkHidden = Array.from({ length: n }, (): boolean => false);
  const hunkReason = Array.from({ length: n }, (): GapReason => "using");
  for (let i = 0; i <= n; i++) {
    if (i === n || lines[i]!.kind === "hunk") {
      if (hunkStart >= 0) {
        let allHidden = true;
        let anyRemoved = removed[hunkStart]!;
        for (let j = hunkStart + 1; j < i; j++) {
          const l = lines[j]!;
          if (l.kind !== "eof" && !hidden(j)) allHidden = false;
          if (removed[j]) anyRemoved = true;
        }
        hunkHidden[hunkStart] = allHidden;
        hunkReason[hunkStart] = anyRemoved ? "removed" : "using";
        if (removed[hunkStart] && !allHidden)
          problems.push(`remove: line ${hunkStart + 1} is a hunk header; remove it only with every line of its hunk.`);
      }
      hunkStart = i;
    }
  }

  if (problems.length) return { ok: false, problems };

  const rows: ReadingRow[] = [];
  const stats: ReadingStats = {
    changed: 0,
    visibleChanged: 0,
    removedChanged: 0,
    foldedChanged: 0,
    usingChanged: 0,
    folds: folds.length,
  };
  const pushGap = (reason: GapReason, line: number) => {
    const last = rows.at(-1);
    if (last?.kind === "gap" && last.reason === reason && last.end_line === line - 1) last.end_line = line;
    else rows.push({ kind: "gap", reason, start_line: line, end_line: line });
  };
  for (let i = 0; i < n; i++) {
    const l = lines[i]!;
    const line = i + 1;
    if (l.kind === "hunk") {
      if (hunkHidden[i]) pushGap(hunkReason[i]!, line);
      else rows.push({ kind: "hunk", line, text: l.text });
      continue;
    }
    if (l.kind === "eof") {
      // The marker belongs to the line before it.
      const prev = rows.at(-1);
      if (prev && prev.kind !== "gap" && prev.kind !== "fold") rows.push({ kind: "eof", line, text: l.text });
      else if (prev?.kind === "gap") prev.end_line = line;
      else if (prev?.kind === "fold" && prev.end_line === line - 1) prev.end_line = line;
      continue;
    }
    const isChange = l.kind !== "ctx";
    if (isChange) stats.changed++;
    if (foldAt[i] >= 0) {
      if (isChange) stats.foldedChanged++;
      const fold = folds[foldAt[i]!]!;
      if (fold.start_line === line) rows.push({ ...fold });
      continue;
    }
    if (hidden(i)) {
      if (isChange) {
        if (removed[i]) stats.removedChanged++;
        else stats.usingChanged++;
      }
      pushGap(removed[i] ? "removed" : "using", line);
      continue;
    }
    if (isChange) stats.visibleChanged++;
    const spans = elisions.get(i);
    rows.push({
      kind: l.kind,
      line,
      text: spans ? applyElisions(l.text, spans) : l.text,
      old: l.old,
      new: l.new,
      elided: Boolean(spans),
    });
  }
  return { ok: true, rows, stats };
}

/** `kept 12/40 changed lines`, computed from the plan, never from the agent's claims. */
export function keptLine(stats: ReadingStats): string {
  if (stats.changed === 0) return "no changed lines";
  if (stats.visibleChanged === 0) return `hid all ${stats.changed} changed lines`;
  return `kept ${stats.visibleChanged}/${stats.changed} changed lines`;
}

/**
 * Whether `next` is `old` with some spans replaced by `...` or `…`. Each
 * placeholder must stand for at least one character, so `!allowed` cannot
 * quietly become `allowed`, and two placeholders may not touch.
 */
export function isElision(old: string, next: string): boolean {
  const parts = next.split(/\.\.\.|…/);
  if (parts.length < 2) return false;
  if (/\.{4,}/.test(next)) return false;
  for (let k = 1; k < parts.length - 1; k++) if (parts[k] === "") return false;
  const pattern = parts.map(escapeRegExp).join("[\\s\\S]+");
  return new RegExp(`^${pattern}$`).test(old);
}

function applyElisions(text: string, spans: { start: number; end: number; new: string }[]) {
  let out = "";
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, s.start) + s.new;
    at = s.end;
  }
  return out + text.slice(at);
}

function commonIndent(texts: string[]): string {
  let indent: string | null = null;
  for (const t of texts) {
    if (t.trim() === "") continue;
    const own = t.match(/^[ \t]*/)![0];
    if (indent === null) indent = own;
    else {
      let k = 0;
      while (k < indent.length && k < own.length && indent[k] === own[k]) k++;
      indent = indent.slice(0, k);
    }
  }
  return indent ?? "";
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
