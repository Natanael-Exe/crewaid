import type { ContentPart, ModelMessage } from '@tanstack/ai';

export type VaultKind = 'EMAIL' | 'PHONE' | 'CARD' | 'SSN' | 'OTP' | 'SECRET';

export interface VaultEntry {
  readonly kind: VaultKind;
  readonly index: number;
  readonly token: string;
  readonly original: string;
  readonly masked: string;
  readonly bareHint?: string;
}

export interface ResolveOptions {
  /** Replace high-sensitivity categories (SECRET, OTP, CARD, SSN) with masked placeholders for display. */
  readonly maskSecrets?: boolean;
  /** Escape resolved text for insertion inside an already-quoted JSON string fragment. */
  readonly jsonStringEscape?: boolean;
}

const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'fastmail.com',
  'aol.com',
  'zoho.com',
  'gmx.com',
  'gmx.net',
]);

/** Common file extensions that follow `@` in asset names like `icon@2x.png`. */
const FILE_EXTENSION_TLDS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
  'bmp',
  'tiff',
  'avif',
  'mp4',
  'mov',
  'webm',
  'mp3',
  'wav',
  'ogg',
  'pdf',
  'zip',
  'tar',
  'gz',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'xml',
  'json',
  'yaml',
  'yml',
  'toml',
  'py',
  'rb',
  'go',
  'rs',
  'sh',
  'md',
  'txt',
  'csv',
  'log',
  'lock',
  'map',
]);

const SENSITIVE_MASK_KINDS: ReadonlySet<VaultKind> = new Set(['SECRET', 'OTP', 'CARD', 'SSN']);

const EXISTING_TOKEN_RE = /\[\[(?:EMAIL|PHONE|CARD|SSN|OTP|SECRET)_\d+(?::[^\]\s]{1,80})?\]\]/g;
const RESOLVE_TOKEN_RE = /\[\[((?:EMAIL|PHONE|CARD|SSN|OTP|SECRET)_\d+)(?::[^\]\s]{1,80})?\]\]/g;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{24,}\b/g,
];

const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])([A-Za-z0-9][A-Za-z0-9._%+-]{0,63})@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)(?![A-Za-z0-9_%+-]|\.[A-Za-z0-9])/g;

const CARD_RE = /(?<![A-Za-z0-9-])([3-6](?:[ -]?\d){12,18})(?![A-Za-z0-9-])/g;

const SSN_RE = /(?<![A-Za-z0-9-])(\d{3})-(\d{2})-(\d{4})(?![A-Za-z0-9-])/g;

const OTP_CONTEXT_RE =
  /\b(?:otp|one[- ]time\s+(?:passcode|password|code)|verification\s+code|security\s+code|login\s+code|sign[- ]in\s+code|2fa\s+code|auth(?:entication)?\s+code|passcode)(?:\s+(?:is|code))?\s*(?::|#|-|\bis\b)?\s*(\d{4,8})\b/gi;

const PHONE_INTL_RE =
  /(?<![\w/.-])(\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{1,4})?)(?![\w-]|\.\d)/g;

const PHONE_NA_RE = /(?<![\w/.-])((?:\(\d{3}\)\s?|\d{3}[.-])\d{3}[.-]\d{4})(?![\w-]|\.\d)/g;

const MAX_TOKEN_BUFFER = 96;

interface MatchSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: VaultKind;
  readonly priority: number;
  readonly value: string;
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let doubleNext = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return false;
    let add = code;
    if (doubleNext) {
      add *= 2;
      if (add > 9) add -= 9;
    }
    sum += add;
    doubleNext = !doubleNext;
  }
  return sum > 0 && sum % 10 === 0;
}

function isValidSsn(area: string, group: string, serial: string): boolean {
  const areaNum = Number(area);
  if (areaNum === 0 || areaNum === 666 || areaNum >= 900) return false;
  if (group === '00' || serial === '0000') return false;
  return true;
}

function maskLocalPart(local: string): string {
  if (local.length >= 3) {
    return `${local.charAt(0)}.....${local.charAt(local.length - 1)}`;
  }
  if (local.length === 2) {
    return `${local.charAt(0)}.....`;
  }
  return '.....';
}

function formatMasked(kind: VaultKind, original: string): { masked: string; bareHint?: string } {
  if (kind === 'EMAIL') {
    const at = original.indexOf('@');
    const local = at > 0 ? original.slice(0, at) : original;
    const domain = at > 0 ? original.slice(at + 1).toLowerCase() : '';
    const localMask = maskLocalPart(local);
    if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
      const hint = `${localMask}@${domain}`;
      return { masked: hint, bareHint: hint };
    }
    return { masked: `${localMask}@•••••` };
  }
  if (kind === 'CARD') {
    const digits = original.replace(/\D/g, '');
    return { masked: `•••• ${digits.slice(-4)}` };
  }
  if (kind === 'SSN') {
    const digits = original.replace(/\D/g, '');
    return { masked: `•••-••-${digits.slice(-4)}` };
  }
  if (kind === 'OTP') {
    return { masked: '••••••' };
  }
  if (kind === 'SECRET') {
    return { masked: original.length > 10 ? `${original.slice(0, 4)}••••` : '••••••' };
  }
  const digits = original.replace(/\D/g, '');
  return { masked: digits.length >= 4 ? `•••-${digits.slice(-4)}` : '••••' };
}

function normalizeLookupKey(kind: VaultKind, original: string): string {
  if (kind === 'EMAIL') return original.toLowerCase();
  if (kind === 'PHONE' || kind === 'CARD' || kind === 'SSN') return original.replace(/\D/g, '');
  return original;
}

function escapeJsonStringFragment(value: string): string {
  // JSON.stringify adds surrounding quotes; strip them to get valid JSON string content.
  return JSON.stringify(value).slice(1, -1);
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function detectSpans(text: string): MatchSpan[] {
  const protectedRanges: Array<{ start: number; end: number }> = [];
  EXISTING_TOKEN_RE.lastIndex = 0;
  for (let m = EXISTING_TOKEN_RE.exec(text); m !== null; m = EXISTING_TOKEN_RE.exec(text)) {
    protectedRanges.push({ start: m.index, end: m.index + m[0].length });
  }

  const candidates: MatchSpan[] = [];
  const push = (start: number, end: number, kind: VaultKind, priority: number, value: string) => {
    if (end <= start) return;
    for (const guard of protectedRanges) {
      if (overlaps({ start, end }, guard)) return;
    }
    candidates.push({ start, end, kind, priority, value });
  };

  // 1. High-confidence credentials, API keys, JWTs, Bearer tokens.
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      push(m.index, m.index + m[0].length, 'SECRET', 100, m[0]);
    }
  }

  // 2. Email addresses.
  EMAIL_RE.lastIndex = 0;
  for (let m = EMAIL_RE.exec(text); m !== null; m = EMAIL_RE.exec(text)) {
    const domain = m[2];
    if (domain === undefined) continue;
    const tld = domain.slice(domain.lastIndexOf('.') + 1).toLowerCase();
    if (!/^[a-z]{2,24}$/.test(tld) || FILE_EXTENSION_TLDS.has(tld)) continue;
    push(m.index, m.index + m[0].length, 'EMAIL', 90, m[0]);
  }

  // 3. Payment card numbers (Luhn-validated to avoid matching numeric IDs).
  CARD_RE.lastIndex = 0;
  for (let m = CARD_RE.exec(text); m !== null; m = CARD_RE.exec(text)) {
    const raw = m[1];
    if (raw === undefined) continue;
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (!passesLuhn(digits)) continue;
    push(m.index, m.index + raw.length, 'CARD', 80, raw);
  }

  // 4. Formatted US SSNs.
  SSN_RE.lastIndex = 0;
  for (let m = SSN_RE.exec(text); m !== null; m = SSN_RE.exec(text)) {
    const area = m[1];
    const group = m[2];
    const serial = m[3];
    if (area === undefined || group === undefined || serial === undefined) continue;
    if (!isValidSsn(area, group, serial)) continue;
    push(m.index, m.index + m[0].length, 'SSN', 75, m[0]);
  }

  // 5. Contextual OTP / verification codes (replace only the numeric code).
  OTP_CONTEXT_RE.lastIndex = 0;
  for (let m = OTP_CONTEXT_RE.exec(text); m !== null; m = OTP_CONTEXT_RE.exec(text)) {
    const code = m[1];
    if (code === undefined) continue;
    const offset = m[0].lastIndexOf(code);
    if (offset < 0) continue;
    const start = m.index + offset;
    push(start, start + code.length, 'OTP', 70, code);
  }

  // 6. Formatted phone numbers (strictly separated to avoid matching dates/IPs/versions).
  for (const pattern of [PHONE_INTL_RE, PHONE_NA_RE]) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      const raw = m[1];
      if (raw === undefined) continue;
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) continue;
      // Avoid matching ISO timestamps or dotted IPv4 addresses.
      if (/^\d{4}-\d{2}-\d{2}/.test(raw)) continue;
      push(m.index, m.index + raw.length, 'PHONE', 60, raw);
    }
  }

  // Resolve overlaps: higher priority wins, then longer match, then earlier offset.
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const lenDiff = b.end - b.start - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return a.start - b.start;
  });

  const accepted: MatchSpan[] = [];
  for (const candidate of candidates) {
    if (accepted.some((existing) => overlaps(existing, candidate))) continue;
    accepted.push(candidate);
  }

  // Sort left-to-right so vault indices are assigned deterministically in reading order.
  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

/**
 * Per-run privacy vault that replaces sensitive PII and credentials with stable
 * tokens before messages leave for an LLM provider, then restores real values
 * automatically for tool execution, approval prompts, and user-facing chat.
 */
export class PrivacyVault {
  private readonly counters: Record<VaultKind, number> = {
    EMAIL: 0,
    PHONE: 0,
    CARD: 0,
    SSN: 0,
    OTP: 0,
    SECRET: 0,
  };
  private readonly byKey = new Map<string, VaultEntry>();
  private readonly byId = new Map<string, VaultEntry>();
  private readonly byBareHint = new Map<string, VaultEntry | 'ambiguous'>();
  private maxBareHintLen = 0;

  get size(): number {
    return this.byKey.size;
  }

  entries(): readonly VaultEntry[] {
    return [...this.byKey.values()];
  }

  hasBareHints(): boolean {
    return this.maxBareHintLen > 0;
  }

  private register(kind: VaultKind, original: string): VaultEntry {
    const key = `${kind}:${normalizeLookupKey(kind, original)}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;

    const index = this.counters[kind] + 1;
    this.counters[kind] = index;
    const id = `${kind}_${String(index)}`;
    const { masked, bareHint } = formatMasked(kind, original);
    const token = bareHint === undefined ? `[[${id}]]` : `[[${id}:${bareHint}]]`;
    const entry: VaultEntry = {
      kind,
      index,
      token,
      original,
      masked,
      ...(bareHint === undefined ? {} : { bareHint }),
    };

    this.byKey.set(key, entry);
    this.byId.set(id, entry);
    if (bareHint !== undefined) {
      const hintKey = bareHint.toLowerCase();
      this.byBareHint.set(hintKey, this.byBareHint.has(hintKey) ? 'ambiguous' : entry);
      if (bareHint.length > this.maxBareHintLen) {
        this.maxBareHintLen = bareHint.length;
      }
    }
    return entry;
  }

  redactText(text: string): string {
    if (text === '') return text;
    const spans = detectSpans(text);
    if (spans.length === 0) return text;
    let out = '';
    let cursor = 0;
    for (const span of spans) {
      out += text.slice(cursor, span.start);
      const entry = this.register(span.kind, span.value);
      out += entry.token;
      cursor = span.end;
    }
    out += text.slice(cursor);
    return out;
  }

  redactValue(value: unknown): unknown {
    if (typeof value === 'string') return this.redactText(value);
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item));
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this.redactValue(v);
      }
      return out;
    }
    return value;
  }

  private renderEntry(entry: VaultEntry, options?: ResolveOptions): string {
    const raw =
      options?.maskSecrets === true && SENSITIVE_MASK_KINDS.has(entry.kind)
        ? entry.masked
        : entry.original;
    return options?.jsonStringEscape === true ? escapeJsonStringFragment(raw) : raw;
  }

  resolveText(text: string, options?: ResolveOptions): string {
    if (text === '' || this.byId.size === 0) return text;

    let resolved = text.replace(RESOLVE_TOKEN_RE, (full, id: string) => {
      const entry = this.byId.get(id);
      return entry === undefined ? full : this.renderEntry(entry, options);
    });

    // If the model dropped the `[[EMAIL_N:...]]` wrapper and echoed the masked
    // consumer email hint (e.g. `b.....9@gmail.com`), resolve unambiguous hits.
    if (this.maxBareHintLen > 0 && resolved.includes('.....')) {
      for (const [hintKey, candidate] of this.byBareHint.entries()) {
        if (candidate === 'ambiguous') continue;
        if (!resolved.toLowerCase().includes(hintKey)) continue;
        const escaped = hintKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(
          `(?<![A-Za-z0-9._%+-])${escaped}(?![A-Za-z0-9_%+-]|\\.[A-Za-z0-9])`,
          'gi',
        );
        resolved = resolved.replace(re, this.renderEntry(candidate, options));
      }
    }

    return resolved;
  }

  resolveValue(value: unknown, options?: ResolveOptions): unknown {
    if (this.byId.size === 0) return value;
    if (typeof value === 'string') return this.resolveText(value, options);
    if (Array.isArray(value)) return value.map((item) => this.resolveValue(item, options));
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this.resolveValue(v, options);
      }
      return out;
    }
    return value;
  }

  private redactContent(
    content: ModelMessage['content'],
  ): ModelMessage['content'] {
    if (typeof content === 'string') return this.redactText(content);
    if (!Array.isArray(content)) return content;
    return content.map(
      (part: ContentPart): ContentPart =>
        part.type === 'text' ? { ...part, content: this.redactText(part.content) } : part,
    );
  }

  private resolveContent(
    content: ModelMessage['content'],
    options?: ResolveOptions,
  ): ModelMessage['content'] {
    if (typeof content === 'string') return this.resolveText(content, options);
    if (!Array.isArray(content)) return content;
    return content.map(
      (part: ContentPart): ContentPart =>
        part.type === 'text' ? { ...part, content: this.resolveText(part.content, options) } : part,
    );
  }

  private transformToolArgs(rawArgs: string, mode: 'redact' | 'resolve'): string {
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      const next = mode === 'redact' ? this.redactValue(parsed) : this.resolveValue(parsed);
      return JSON.stringify(next);
    } catch {
      return mode === 'redact'
        ? this.redactText(rawArgs)
        : this.resolveText(rawArgs, { jsonStringEscape: true });
    }
  }

  /** Return a provider-only copy of `messages` with all detected PII replaced by vault tokens. */
  redactMessages(messages: readonly ModelMessage[]): ModelMessage[] {
    return messages.map((message) => {
      const content = this.redactContent(message.content);
      const toolCalls = message.toolCalls?.map((call) => ({
        ...call,
        function: {
          ...call.function,
          arguments: this.transformToolArgs(call.function.arguments, 'redact'),
        },
      }));
      return {
        ...message,
        content,
        ...(toolCalls === undefined ? {} : { toolCalls }),
      };
    });
  }

  /** Return a canonical copy of `messages` with vault tokens restored to real values. */
  resolveMessages(messages: readonly ModelMessage[], options?: ResolveOptions): ModelMessage[] {
    if (this.byId.size === 0) return [...messages];
    return messages.map((message) => {
      const content = this.resolveContent(message.content, options);
      const toolCalls = message.toolCalls?.map((call) => ({
        ...call,
        function: {
          ...call.function,
          arguments: this.transformToolArgs(call.function.arguments, 'resolve'),
        },
      }));
      return {
        ...message,
        content,
        ...(toolCalls === undefined ? {} : { toolCalls }),
      };
    });
  }

  /** Create a stateful streaming token rehydrator safe across arbitrary SSE chunk splits. */
  createStreamRehydrator(options?: ResolveOptions): StreamTokenRehydrator {
    return new StreamTokenRehydrator(this, options);
  }

  /** Length of the longest suffix of `text` that could still complete a vault token or bare hint. */
  pendingTailLength(text: string): number {
    if (this.byId.size === 0 || text === '') return 0;
    let hold = 0;

    // Hold trailing `[` or unclosed `[[...` up to MAX_TOKEN_BUFFER chars.
    const open = text.lastIndexOf('[[');
    if (open !== -1) {
      const tail = text.slice(open);
      if (!tail.includes(']]') && tail.length < MAX_TOKEN_BUFFER) {
        hold = Math.max(hold, tail.length);
      }
    }
    if (hold === 0 && text.endsWith('[')) {
      hold = 1;
    }

    // Hold partial bare consumer-email hint (e.g. `b.....9@gmai`) if one is in flight.
    if (this.maxBareHintLen > 0) {
      const maxCheck = Math.min(text.length, this.maxBareHintLen - 1);
      const tailLower = text.slice(text.length - maxCheck).toLowerCase();
      for (const [hintKey, candidate] of this.byBareHint.entries()) {
        if (candidate === 'ambiguous') continue;
        const limit = Math.min(tailLower.length, hintKey.length - 1);
        for (let len = limit; len >= 2; len--) {
          if (hintKey.startsWith(tailLower.slice(tailLower.length - len))) {
            hold = Math.max(hold, len);
            break;
          }
        }
      }
    }

    return hold;
  }
}

export class StreamTokenRehydrator {
  private pending = '';

  constructor(
    private readonly vault: PrivacyVault,
    private readonly options?: ResolveOptions,
  ) {}

  push(delta: string): string {
    if (delta === '') return '';
    if (this.vault.size === 0 && this.pending === '') return delta;
    const combined = this.pending + delta;
    const hold = this.vault.pendingTailLength(combined);
    if (hold === 0) {
      this.pending = '';
      return this.vault.resolveText(combined, this.options);
    }
    const split = combined.length - hold;
    this.pending = combined.slice(split);
    const safe = combined.slice(0, split);
    return safe === '' ? '' : this.vault.resolveText(safe, this.options);
  }

  flush(): string {
    if (this.pending === '') return '';
    const remaining = this.pending;
    this.pending = '';
    return this.vault.resolveText(remaining, this.options);
  }
}
