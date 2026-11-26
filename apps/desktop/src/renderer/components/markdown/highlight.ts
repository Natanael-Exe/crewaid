import type { CodeHighlighterPlugin } from 'streamdown';

type HighlightResult = ReturnType<CodeHighlighterPlugin['highlight']> & {};

/**
 * Code highlighting for transcript fences and tool cards: a small,
 * dependency-free tokenizer that only ever emits text plus allowlisted `hljs-*`
 * class names (never HTML), served to Streamdown through its highlighter
 * plugin interface so the code block, its copy/download controls and its
 * streaming shape are Streamdown's. Unknown languages stay readable plain code
 * instead of a guess.
 */
export type HighlightToken = {
  text: string;
  className: string | null;
};

const LANGUAGE_ALIASES: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  'c++': 'cpp',
  containerfile: 'dockerfile',
  cpp: 'cpp',
  css: 'css',
  diff: 'diff',
  docker: 'dockerfile',
  dockerfile: 'dockerfile',
  go: 'go',
  golang: 'go',
  html: 'xml',
  java: 'java',
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  markdown: 'markdown',
  md: 'markdown',
  patch: 'diff',
  py: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  sh: 'bash',
  shell: 'bash',
  sql: 'sql',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

/** File extensions that are not already a fence alias above. */
const EXTENSION_LANGUAGES: Record<string, string> = {
  cc: 'cpp',
  cjs: 'javascript',
  cts: 'typescript',
  cxx: 'cpp',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  htm: 'xml',
  hxx: 'cpp',
  jsonc: 'json',
  less: 'css',
  mdx: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  pyi: 'python',
  scss: 'css',
  svg: 'xml',
  zsh: 'bash',
};

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  bash: new Set([
    'case',
    'do',
    'done',
    'elif',
    'else',
    'esac',
    'fi',
    'for',
    'function',
    'if',
    'in',
    'then',
    'until',
    'while',
  ]),
  c: new Set([
    'break',
    'case',
    'char',
    'const',
    'continue',
    'default',
    'do',
    'double',
    'else',
    'enum',
    'extern',
    'float',
    'for',
    'goto',
    'if',
    'int',
    'long',
    'return',
    'short',
    'signed',
    'sizeof',
    'static',
    'struct',
    'switch',
    'typedef',
    'union',
    'unsigned',
    'void',
    'volatile',
    'while',
  ]),
  cpp: new Set([
    'auto',
    'bool',
    'break',
    'case',
    'catch',
    'char',
    'class',
    'const',
    'continue',
    'default',
    'delete',
    'do',
    'double',
    'else',
    'enum',
    'explicit',
    'false',
    'float',
    'for',
    'if',
    'int',
    'namespace',
    'new',
    'nullptr',
    'private',
    'protected',
    'public',
    'return',
    'static',
    'struct',
    'switch',
    'template',
    'this',
    'throw',
    'true',
    'try',
    'typedef',
    'typename',
    'using',
    'virtual',
    'void',
    'while',
  ]),
  css: new Set(['@media', '@supports', 'content', 'display', 'flex', 'grid', 'margin', 'padding']),
  // Dockerfile instructions, matched only as the first word of a line.
  dockerfile: new Set([
    'add',
    'arg',
    'cmd',
    'copy',
    'entrypoint',
    'env',
    'expose',
    'from',
    'healthcheck',
    'label',
    'maintainer',
    'onbuild',
    'run',
    'shell',
    'stopsignal',
    'user',
    'volume',
    'workdir',
  ]),
  go: new Set([
    'break',
    'case',
    'chan',
    'const',
    'continue',
    'default',
    'defer',
    'else',
    'fallthrough',
    'for',
    'func',
    'go',
    'goto',
    'if',
    'import',
    'interface',
    'map',
    'package',
    'range',
    'return',
    'select',
    'struct',
    'switch',
    'type',
    'var',
  ]),
  java: new Set([
    'abstract',
    'assert',
    'boolean',
    'break',
    'byte',
    'case',
    'catch',
    'char',
    'class',
    'continue',
    'default',
    'do',
    'double',
    'else',
    'enum',
    'extends',
    'final',
    'finally',
    'float',
    'for',
    'if',
    'implements',
    'import',
    'instanceof',
    'int',
    'interface',
    'long',
    'new',
    'package',
    'permits',
    'private',
    'protected',
    'public',
    'record',
    'return',
    'sealed',
    'short',
    'static',
    'super',
    'switch',
    'synchronized',
    'this',
    'throw',
    'throws',
    'try',
    'var',
    'void',
    'volatile',
    'while',
    'yield',
  ]),
  javascript: new Set([
    'as',
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'export',
    'extends',
    'finally',
    'for',
    'from',
    'function',
    'get',
    'if',
    'import',
    'in',
    'instanceof',
    'let',
    'new',
    'of',
    'return',
    'set',
    'static',
    'switch',
    'throw',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
  ]),
  json: new Set(['false', 'null', 'true']),
  markdown: new Set([]),
  python: new Set([
    'and',
    'as',
    'assert',
    'async',
    'await',
    'class',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'finally',
    'for',
    'from',
    'global',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'try',
    'while',
    'with',
    'yield',
  ]),
  rust: new Set([
    'as',
    'async',
    'await',
    'break',
    'const',
    'continue',
    'crate',
    'dyn',
    'else',
    'enum',
    'extern',
    'fn',
    'for',
    'if',
    'impl',
    'in',
    'let',
    'loop',
    'match',
    'mod',
    'move',
    'mut',
    'pub',
    'ref',
    'return',
    'self',
    'static',
    'struct',
    'super',
    'trait',
    'type',
    'unsafe',
    'use',
    'where',
    'while',
  ]),
  sql: new Set([
    'alter',
    'and',
    'as',
    'by',
    'case',
    'create',
    'delete',
    'drop',
    'else',
    'from',
    'group',
    'having',
    'in',
    'insert',
    'into',
    'join',
    'left',
    'limit',
    'not',
    'null',
    'on',
    'or',
    'order',
    'right',
    'select',
    'set',
    'table',
    'then',
    'union',
    'update',
    'values',
    'when',
    'where',
    'with',
  ]),
  toml: new Set([]),
  typescript: new Set([
    'as',
    'async',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'declare',
    'default',
    'delete',
    'do',
    'else',
    'export',
    'extends',
    'finally',
    'for',
    'from',
    'function',
    'get',
    'if',
    'implements',
    'import',
    'in',
    'infer',
    'instanceof',
    'interface',
    'keyof',
    'let',
    'new',
    'never',
    'null',
    'of',
    'override',
    'private',
    'protected',
    'public',
    'readonly',
    'return',
    'satisfies',
    'set',
    'static',
    'string',
    'switch',
    'throw',
    'try',
    'type',
    'typeof',
    'undefined',
    'unknown',
    'var',
    'void',
    'while',
    'with',
    'yield',
  ]),
  xml: new Set([]),
  yaml: new Set(['false', 'null', 'true']),
};

/** Compared lowercased, like keywords, so `None`, `NaN` and `NULL` all count. */
const LITERAL_WORDS = new Set(['false', 'nan', 'nil', 'none', 'null', 'true', 'undefined']);

/**
 * What a matched token is. Most kinds name their class directly (`hljs-<kind>`);
 * `word` is classified against the language's keywords, and `line-keyword` is
 * a first word of a line that is a keyword only when it is in that list.
 */
type TokenKind = 'comment' | 'string' | 'number' | 'section' | 'attr' | 'word' | 'line-keyword';
type TokenRule = readonly [pattern: string, kind: TokenKind];

const LINE_START = String.raw`(?<=^[ \t]*)`;
const SLASH_COMMENT: TokenRule = [String.raw`\/\/[^\r\n]*`, 'comment'];
const BLOCK_COMMENT: TokenRule = [String.raw`\/\*[\s\S]*?\*\/`, 'comment'];
const HASH_COMMENT: TokenRule = [String.raw`#[^\r\n]*`, 'comment'];
const DOUBLE_QUOTED: TokenRule = [String.raw`"(?:\\[\s\S]|[^"\\])*"`, 'string'];
const SINGLE_QUOTED: TokenRule = [String.raw`'(?:\\[\s\S]|[^'\\])*'`, 'string'];
const BACKTICK_QUOTED: TokenRule = [String.raw`\x60(?:\\[\s\S]|[^\x60\\])*\x60`, 'string'];
const NUMBER: TokenRule = [String.raw`\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b`, 'number'];
const WORD: TokenRule = [String.raw`[A-Za-z_$][\w$-]*`, 'word'];

const SLASH_COMMENTED: readonly TokenRule[] = [
  SLASH_COMMENT,
  BLOCK_COMMENT,
  DOUBLE_QUOTED,
  SINGLE_QUOTED,
  BACKTICK_QUOTED,
  NUMBER,
  WORD,
];
// `//` is not a comment here: it is a URL in a shell line and floor division
// in Python, so these languages comment with `#` alone.
const HASH_COMMENTED: readonly TokenRule[] = [
  HASH_COMMENT,
  DOUBLE_QUOTED,
  SINGLE_QUOTED,
  BACKTICK_QUOTED,
  NUMBER,
  WORD,
];

/** Ordered: at any position, the first rule that matches wins. */
const LANGUAGE_RULES: Record<string, readonly TokenRule[]> = {
  bash: HASH_COMMENTED,
  c: SLASH_COMMENTED,
  cpp: SLASH_COMMENTED,
  css: SLASH_COMMENTED,
  // Instructions and comments only count at the start of a line; everything
  // after an instruction is its shell command or arguments.
  dockerfile: [
    [`${LINE_START}#[^\\r\\n]*`, 'comment'],
    [`${LINE_START}[A-Za-z]+(?=[ \\t]|$)`, 'line-keyword'],
    DOUBLE_QUOTED,
    SINGLE_QUOTED,
    NUMBER,
  ],
  go: SLASH_COMMENTED,
  java: SLASH_COMMENTED,
  javascript: SLASH_COMMENTED,
  json: SLASH_COMMENTED,
  markdown: HASH_COMMENTED,
  python: HASH_COMMENTED,
  // A Rust `'` opens a char literal only when it closes on the same line;
  // otherwise it is a lifetime (`'a`), which must not swallow the next quote.
  rust: [
    SLASH_COMMENT,
    BLOCK_COMMENT,
    DOUBLE_QUOTED,
    [String.raw`'(?:\\[^\r\n]+?|[^'\\\r\n])'`, 'string'],
    NUMBER,
    WORD,
  ],
  sql: SLASH_COMMENTED,
  // TOML literal strings have no escapes, and `[table]` headers and bare keys
  // are what a reader scans a config file by.
  toml: [
    [`${LINE_START}\\[\\[?[^\\]\\r\\n]+\\]\\]?`, 'section'],
    [`${LINE_START}[\\w-]+(?:[ \\t]*\\.[ \\t]*[\\w-]+)*(?=[ \\t]*=)`, 'attr'],
    HASH_COMMENT,
    [String.raw`"""[\s\S]*?"""`, 'string'],
    [String.raw`'''[\s\S]*?'''`, 'string'],
    DOUBLE_QUOTED,
    [String.raw`'[^'\r\n]*'`, 'string'],
    NUMBER,
    WORD,
  ],
  typescript: SLASH_COMMENTED,
  xml: SLASH_COMMENTED,
  yaml: HASH_COMMENTED,
};

const TOKEN_PATTERNS = new Map<string, RegExp>();

/** One alternation per language, each rule its own capture group, built once. */
function tokenPattern(language: string, rules: readonly TokenRule[]): RegExp {
  let pattern = TOKEN_PATTERNS.get(language);
  if (pattern === undefined) {
    pattern = new RegExp(rules.map(([source]) => `(${source})`).join('|'), 'gm');
    TOKEN_PATTERNS.set(language, pattern);
  }
  return pattern;
}

export function normalizeCodeLanguage(rawLanguage: string | null): string | null {
  if (rawLanguage === null) return null;
  const candidate = rawLanguage
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+#.-]/g, '');
  return candidate === '' ? null : candidate;
}

function canonicalLanguage(rawLanguage: string | null): string | null {
  if (rawLanguage === null) return null;
  const normalized = normalizeCodeLanguage(rawLanguage);
  if (normalized === null) return null;
  return LANGUAGE_ALIASES[normalized] ?? null;
}

/**
 * The highlighter language for a file path, from its name or extension, or
 * `null` when the file is not one the highlighter knows — that file then
 * stays plain text rather than a guess.
 */
export function languageForPath(filePath: string): string | null {
  const name = filePath.trim().split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (/^(?:docker|container)file(?:\..+)?$/.test(name)) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1);
  return EXTENSION_LANGUAGES[extension] ?? canonicalLanguage(extension);
}

function isIdentifier(token: string): boolean {
  return /^[A-Za-z_$][\w$-]*$/.test(token);
}

export type DiffLineKind = 'addition' | 'deletion' | 'context' | 'hunk' | 'header';

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const FILE_HEADER =
  /^(?:diff |index |--- |\+\+\+ |Index: |new file mode |deleted file mode |similarity index |rename (?:from|to) |={3,}$)/;

/**
 * What each line of a unified diff is. A counted hunk (`@@ -1,3 +1,4 @@`) is
 * followed to its end, so a removed line that itself starts with `--` is not
 * mistaken for the next file's `---` header; a hunk header without counts, or
 * a bare run of `-`/`+` lines, is read line by line.
 */
export function classifyDiffLines(lines: readonly string[]): DiffLineKind[] {
  let oldLeft = 0;
  let newLeft = 0;
  let uncounted = false;
  return lines.map((line): DiffLineKind => {
    if (line.startsWith('@@')) {
      const counts = HUNK_HEADER.exec(line);
      uncounted = counts === null;
      oldLeft = counts === null ? 0 : Number(counts[1] ?? 1);
      newLeft = counts === null ? 0 : Number(counts[2] ?? 1);
      return 'hunk';
    }
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        newLeft -= 1;
        return 'addition';
      }
      if (line.startsWith('-')) {
        oldLeft -= 1;
        return 'deletion';
      }
      // `\ No newline at end of file` annotates the line before it.
      if (line.startsWith('\\')) return 'header';
      oldLeft -= 1;
      newLeft -= 1;
      return 'context';
    }
    if (line.startsWith('diff ')) uncounted = false;
    if (!uncounted && FILE_HEADER.test(line)) return 'header';
    if (line.startsWith('\\')) return 'header';
    if (line.startsWith('+')) return 'addition';
    if (line.startsWith('-')) return 'deletion';
    return 'context';
  });
}

const DIFF_CLASSES: Readonly<Record<DiffLineKind, string | null>> = {
  addition: 'hljs-addition',
  deletion: 'hljs-deletion',
  hunk: 'hljs-meta',
  header: 'hljs-comment',
  context: null,
};

/** A fenced diff: each line is one token, classed by what the line is. */
function highlightDiff(value: string): HighlightToken[] {
  const lines = value.split('\n');
  const kinds = classifyDiffLines(lines);
  const tokens: HighlightToken[] = [];
  lines.forEach((line, index) => {
    if (index > 0) tokens.push({ text: '\n', className: null });
    if (line !== '')
      tokens.push({ text: line, className: DIFF_CLASSES[kinds[index] ?? 'context'] });
  });
  return tokens.length === 0 ? [{ text: value, className: null }] : tokens;
}

function wordClass(
  token: string,
  keywords: ReadonlySet<string>,
  value: string,
  end: number,
): string | null {
  const lower = token.toLowerCase();
  if (LITERAL_WORDS.has(lower)) return 'hljs-literal';
  if (keywords.has(lower)) return 'hljs-keyword';
  if (isIdentifier(token) && /^\s*\(/.test(value.slice(end))) return 'hljs-title';
  return null;
}

/**
 * A deliberately small, dependency-free highlighter. It emits text plus
 * allowlisted class names as React nodes, never HTML strings. Unknown fences
 * remain readable plain code instead of guessing a language.
 */
export function highlightCode(value: string, rawLanguage: string | null): HighlightToken[] {
  const language = canonicalLanguage(rawLanguage);
  if (language === null) return [{ text: value, className: null }];
  if (language === 'diff') return highlightDiff(value);
  const rules = LANGUAGE_RULES[language];
  if (rules === undefined) return [{ text: value, className: null }];

  const keywords = KEYWORDS[language] ?? new Set<string>();
  const tokens: HighlightToken[] = [];
  let cursor = 0;

  for (const match of value.matchAll(tokenPattern(language, rules))) {
    const token = match[0];
    const position = match.index ?? cursor;
    if (position > cursor) tokens.push({ text: value.slice(cursor, position), className: null });

    const ruleIndex = match.findIndex((group, index) => index > 0 && group !== undefined) - 1;
    const kind = rules[ruleIndex]?.[1];
    const end = position + token.length;
    const className =
      kind === 'word'
        ? wordClass(token, keywords, value, end)
        : kind === 'line-keyword'
          ? keywords.has(token.toLowerCase())
            ? 'hljs-keyword'
            : null
          : kind === undefined
            ? null
            : `hljs-${kind}`;
    tokens.push({ text: token, className });
    cursor = end;
  }

  if (cursor < value.length) tokens.push({ text: value.slice(cursor), className: null });
  return tokens.length === 0 ? [{ text: value, className: null }] : tokens;
}

/** Tokens regrouped into one array per source line; a token that spans lines is split. */
export function splitTokenLines(tokens: readonly HighlightToken[]): HighlightToken[][] {
  const lines: HighlightToken[][] = [[]];
  for (const token of tokens) {
    token.text.split('\n').forEach((piece, index) => {
      if (index > 0) lines.push([]);
      if (piece !== '') lines[lines.length - 1]?.push({ text: piece, className: token.className });
    });
  }
  return lines;
}

/**
 * Highlight lines that read as one piece of code, so a block comment or
 * string that spans lines is still recognised, returned one array per line.
 */
export function highlightLines(
  lines: readonly string[],
  rawLanguage: string | null,
): HighlightToken[][] {
  if (lines.length === 0) return [];
  return splitTokenLines(highlightCode(lines.join('\n'), rawLanguage));
}

/** Streamdown's highlighter port over `highlightCode`: synchronous, so a static render shows tokens. */
export const codeHighlighter: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getSupportedLanguages: () => Object.keys(LANGUAGE_ALIASES),
  getThemes: () => ['github-light', 'github-dark'],
  supportsLanguage: (language) => canonicalLanguage(language) !== null,
  highlight({ code, language }): HighlightResult {
    return {
      tokens: splitTokenLines(highlightCode(code, language)).map((line) =>
        line.map((token) => ({
          content: token.text,
          // Spread onto the token's React element, so `className`, not `class`.
          ...(token.className === null ? {} : { htmlAttrs: { className: token.className } }),
        })),
      ),
    };
  },
};
