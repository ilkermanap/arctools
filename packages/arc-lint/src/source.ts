/**
 * Blanks out comments -- and optionally string literals -- while preserving byte
 * offsets, so rules can match with plain regexes and never fire inside a comment.
 *
 * Solidity rules match on structure, so blanking strings removes false positives
 * from revert messages. Script rules read config values that live *inside*
 * strings (RPC URLs, parseGwei("5")), so they need them kept.
 */
export function stripNonCode(src: string, stripStrings = true): string {
  const out = src.split("");
  let i = 0;
  const n = src.length;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      let end = src.indexOf("\n", i);
      if (end === -1) end = n;
      blank(i, end);
      i = end;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      // Always parse the literal, even when keeping it: a URL like
      // "http://host:8545" contains // and would otherwise eat the line.
      let k = i + 1;
      while (k < n && src[k] !== c) {
        if (src[k] === "\\") k++;
        if (src[k] === "\n") break;
        k++;
      }
      if (stripStrings) blank(i, Math.min(k + 1, n));
      i = k + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

export interface Position {
  line: number;
  column: number;
}

/** Byte offset -> 1-based line/column. */
export function positionAt(src: string, offset: number): Position {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function lineTextAt(src: string, offset: number): string {
  let start = src.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  let end = src.indexOf("\n", offset);
  if (end === -1) end = src.length;
  return src.slice(start, end);
}
