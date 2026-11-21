import type { CodeHighlighterPlugin } from 'streamdown';

type HighlightResult = ReturnType<CodeHighlighterPlugin['highlight']> & {};

/**
 * Code highlighting for transcript fences: a small, dependency-free tokenizer
 * that only ever emits text plus allowlisted `hljs-*` class names (never HTML),
 * served to Streamdown through its highlighter plugin interface so the code
 * block, its copy/download controls and its streaming shape are Streamdown's.
 * Unknown languages stay readable plain code instead of a guess.
 */
export type HighlightToken = {
  text: string;
  className: string | null;
};

const LANGUAGE_ALIASES: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  'c++': 'cpp',
  cpp: 'cpp',
  css: 'css',
  html: 'xml',
  javascript: 'javascript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  markdown: 'markdown',
  md: 'markdown',
  py: 'python',
  python: 'python',
  sh: 'bash',
  shell: 'bash',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
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

const LITERAL_WORDS = new Set(['false', 'null', 'true', 'undefined', 'NaN', 'None']);
const HASH_COMMENT_LANGUAGES = new Set(['bash', 'markdown', 'python', 'yaml']);

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

function isIdentifier(token: string): boolean {
  return /^[A-Za-z_$][\w$-]*$/.test(token);
}

/**
 * A deliberately small, dependency-free highlighter. It emits text plus
 * allowlisted class names as React nodes, never HTML strings. Unknown fences
 * remain readable plain code instead of guessing a language.
 */
export function highlightCode(value: string, rawLanguage: string | null): HighlightToken[] {
  const language = canonicalLanguage(rawLanguage);
  if (language === null) return [{ text: value, className: null }];

  const hashComments = HASH_COMMENT_LANGUAGES.has(language);
  const tokenPattern = new RegExp(
    hashComments
      ? String.raw`\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60|\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b|[A-Za-z_$][\w$-]*`
      : String.raw`\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60|\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b|[A-Za-z_$][\w$-]*`,
    'g',
  );
  const keywords = KEYWORDS[language] ?? new Set<string>();
  const tokens: HighlightToken[] = [];
  let cursor = 0;

  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0];
    const position = match.index ?? cursor;
    if (position > cursor) tokens.push({ text: value.slice(cursor, position), className: null });

    let className: string | null = null;
    if (
      token.startsWith('//') ||
      token.startsWith('/*') ||
      (token.startsWith('#') && hashComments)
    ) {
      className = 'hljs-comment';
    } else if (/^["'`]/.test(token)) {
      className = 'hljs-string';
    } else if (/^(?:0x[\da-fA-F]+|\d)/.test(token)) {
      className = 'hljs-number';
    } else if (LITERAL_WORDS.has(token.toLowerCase())) {
      className = 'hljs-literal';
    } else if (keywords.has(token.toLowerCase())) {
      className = 'hljs-keyword';
    } else if (isIdentifier(token) && /^\s*\(/.test(value.slice(position + token.length))) {
      className = 'hljs-title';
    }
    tokens.push({ text: token, className });
    cursor = position + token.length;
  }

  if (cursor < value.length) tokens.push({ text: value.slice(cursor), className: null });
  return tokens.length === 0 ? [{ text: value, className: null }] : tokens;
}

/** Streamdown's highlighter port over `highlightCode`: synchronous, so a static render shows tokens. */
export const codeHighlighter: CodeHighlighterPlugin = {
  name: 'shiki',
  type: 'code-highlighter',
  getSupportedLanguages: () => Object.keys(LANGUAGE_ALIASES),
  getThemes: () => ['github-light', 'github-dark'],
  supportsLanguage: (language) => canonicalLanguage(language) !== null,
  highlight({ code, language }): HighlightResult {
    const lines: HighlightResult['tokens'] = [[]];
    for (const token of highlightCode(code, language)) {
      token.text.split('\n').forEach((piece, index) => {
        if (index > 0) lines.push([]);
        if (piece === '') return;
        lines[lines.length - 1]?.push({
          content: piece,
          // Spread onto the token's React element, so `className`, not `class`.
          ...(token.className === null ? {} : { htmlAttrs: { className: token.className } }),
        });
      });
    }
    return { tokens: lines };
  },
};
