/**
 * A small bash lexer and parser, just enough to decide whether a command is
 * safe to run without asking. It understands words, quoting, escapes,
 * pipelines, lists (; && || &), and redirections. Anything it can't model
 * precisely (substitutions, subshells, here-docs, functions, brace expansion)
 * is reported so the caller can fall back to asking the person.
 */

export type Word = {
  /** The word after quote removal (with $HOME kept literal for the caller). */
  text: string;
  /** Contains an unquoted glob character (* ? [) that bash would expand. */
  glob: boolean;
  /** Contains a variable or substitution other than a leading $HOME. */
  dynamic: boolean;
  /** Starts with an unquoted ~ (tilde expansion). */
  tilde: boolean;
  /** Was entirely quoted (so leading "-" is still an option, but globbing is off). */
  quoted: boolean;
};

export type Redirect = {
  fd: number | null;
  op: string;
  /** The file or descriptor operand; null for here-strings handled as data. */
  target: Word | null;
};

export type SimpleCommand = {
  assignments: string[];
  argv: Word[];
  redirects: Redirect[];
};

export type Parsed = { ok: true; commands: SimpleCommand[] } | { ok: false; reason: string };

type Token = { kind: "word"; word: Word; start: number; end: number } | { kind: "op"; op: string; start: number };

const OPERATORS = ["&>>", "<<<", "&&", "||", "|&", ";;", "&>", ">>", ">&", ">|", "<<", "<&", "<>", "|", "&", ";", "\n", "(", ")", ">", "<"];
const REDIRECT_OPS = new Set(["&>>", "<<<", "&>", ">>", ">&", ">|", "<<", "<&", "<>", ">", "<"]);
const SEPARATORS = new Set(["|", "|&", "&&", "||", ";", "&", "\n"]);

class Unsupported extends Error {}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const c = input[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "\\" && input[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (c === "#") {
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    const op = OPERATORS.find((o) => input.startsWith(o, i));
    if (op) {
      tokens.push({ kind: "op", op, start: i });
      i += op.length;
      continue;
    }

    // A word: read until whitespace or an operator character.
    const start = i;
    let text = "";
    let glob = false;
    let dynamic = false;
    let quotedAll = true;
    let sawAny = false;
    const tilde = c === "~";
    while (i < n) {
      const ch = input[i]!;
      if (ch === " " || ch === "\t" || ch === "\n" || ";&|()<>".includes(ch)) break;
      sawAny = true;
      if (ch === "'") {
        const end = input.indexOf("'", i + 1);
        if (end < 0) throw new Unsupported("unclosed quote");
        text += input.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        i++;
        while (i < n && input[i] !== '"') {
          const d = input[i]!;
          if (d === "\\" && i + 1 < n && '$`"\\\n'.includes(input[i + 1]!)) {
            text += input[i + 1];
            i += 2;
            continue;
          }
          if (d === "`") throw new Unsupported("command substitution");
          if (d === "$") {
            if (input[i + 1] === "(") throw new Unsupported("command substitution");
            dynamic = true;
          }
          text += d;
          i++;
        }
        if (i >= n) throw new Unsupported("unclosed quote");
        i++;
        continue;
      }
      quotedAll = false;
      if (ch === "\\") {
        if (i + 1 < n) text += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === "`") throw new Unsupported("command substitution");
      if (ch === "$") {
        if (input[i + 1] === "(") throw new Unsupported("command substitution");
        if (input[i + 1] === "'") throw new Unsupported("ANSI-C quoting");
        dynamic = true;
      }
      if (ch === "*" || ch === "?" || ch === "[") glob = true;
      // Any unquoted brace (lists {a,b} and ranges {1..9}, {01..10}) could
      // expand to paths the policy never sees; only the literal {} is safe.
      if (ch === "{" && input[i - 1] !== "$" && !input.startsWith("{}", i)) throw new Unsupported("brace expansion");
      text += ch;
      i++;
    }
    if (!sawAny) {
      i++;
      continue;
    }
    // ~user names another account's home; the policy can't resolve it safely.
    if (tilde && text.length > 1 && text[1] !== "/") dynamic = true;
    // $HOME and ${HOME} at the start of a word are treated like ~.
    if (dynamic && !quotedAll && /^(\$HOME|\$\{HOME\})(\/|$)/.test(text) && !/\$/.test(text.replace(/^(\$HOME|\$\{HOME\})/, ""))) {
      dynamic = false;
    }
    tokens.push({ kind: "word", word: { text, glob, dynamic, tilde, quoted: quotedAll }, start, end: i });
  }
  return tokens;
}

/** Parses a command line into simple commands (pipelines and lists flattened). */
export function parse(input: string): Parsed {
  let tokens: Token[];
  try {
    tokens = lex(input);
  } catch (err) {
    return { ok: false, reason: err instanceof Unsupported ? err.message : "could not read the command" };
  }

  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { assignments: [], argv: [], redirects: [] };
  let lastWordEnd = -1;
  const flush = () => {
    if (current.argv.length || current.assignments.length || current.redirects.length) commands.push(current);
    current = { assignments: [], argv: [], redirects: [] };
  };

  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t]!;
    if (tok.kind === "op") {
      if (SEPARATORS.has(tok.op)) {
        flush();
        continue;
      }
      if (tok.op === "(" || tok.op === ")") return { ok: false, reason: "subshell" };
      if (tok.op === ";;") return { ok: false, reason: "case statement" };
      if (REDIRECT_OPS.has(tok.op)) {
        if (tok.op === "<<") return { ok: false, reason: "here-document" };
        // A preceding all-digit word glued to the operator is a file descriptor.
        let fd: number | null = null;
        const prev = current.argv.at(-1);
        if (prev && /^\d+$/.test(prev.text) && !prev.quoted && lastWordEnd === tok.start) {
          current.argv.pop();
          fd = Number(prev.text);
        }
        const next = tokens[t + 1];
        if (!next || next.kind !== "word") return { ok: false, reason: "redirection without a target" };
        t++;
        current.redirects.push({ fd, op: tok.op, target: tok.op === "<<<" ? null : next.word });
        continue;
      }
      return { ok: false, reason: `unsupported operator ${tok.op}` };
    }
    const w = tok.word;
    lastWordEnd = tok.end;
    if (current.argv.length === 0 && !w.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) {
      current.assignments.push(w.text);
      continue;
    }
    if (current.argv.length === 0 && (w.text === "{" || w.text === "}" || w.text === "!")) {
      return { ok: false, reason: "command group" };
    }
    current.argv.push(w);
  }
  flush();
  return { ok: true, commands };
}
