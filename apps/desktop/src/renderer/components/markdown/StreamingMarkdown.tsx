import { useMemo, type CSSProperties, type ReactNode } from 'react';
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type Components,
  type StreamdownProps,
  type StreamdownTranslations,
} from 'streamdown';
import { botAccentTokens } from '../../styles/botAccent';
import { ExternalLink } from '../ExternalLink';
import type { MentionBot } from '../composer/botMention';
import { codeHighlighter } from './highlight';
import { remarkSoftBreaks } from './breaks';
import { remarkBotMentions } from './mentions';
import { useLocale, useT } from '../../i18n/i18n';

export type StreamingMarkdownProps = {
  source: string;
  className?: string;
  mentionBots?: readonly MentionBot[];
  onBotMention?: (botId: string) => void;
  /** The text is still arriving: repair half-typed Markdown as it streams. */
  streaming?: boolean;
};

/**
 * The HTML and resource policy, stated rather than inherited.
 * Markdown repair is not sanitization, so the policy is explicit here:
 *
 * - No raw HTML. Without `rehype-raw`, Streamdown renders an HTML block as
 * text, so a model writing `<script>` shows the characters, not an element.
 * - The sanitizer's own schema, extended only by the `mention` element and
 * its bot id.
 * - Links: https only, opened by the system browser (`SafeLink`).
 * - No images and no data URLs: an image is shown as its description, so a
 * transcript never makes a remote request on its own.
 */
type Pluggable = NonNullable<StreamdownProps['rehypePlugins']>[number];
type Options = Record<string, unknown>;

/** A default `[plugin, options]` entry with its options extended; fails loudly if the shape moves. */
function configured(
  entry: Pluggable | undefined,
  extend: (defaults: Options) => Options,
): Pluggable {
  const options: unknown = Array.isArray(entry) ? entry[1] : undefined;
  if (!Array.isArray(entry) || typeof options !== 'object' || options === null)
    throw new Error('Streamdown changed the shape of its default rehype plugins.');
  return [entry[0], extend({ ...options })];
}

function tagNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string')
    : [];
}

const REHYPE_PLUGINS: Pluggable[] = [
  configured(defaultRehypePlugins['sanitize'], (schema) => ({
    ...schema,
    tagNames: [...tagNames(schema['tagNames']), 'mention'],
    attributes: {
      ...(typeof schema['attributes'] === 'object' ? schema['attributes'] : {}),
      mention: ['botid'],
    },
  })),
  // The hardener's specific prefixes need an origin to resolve against, which a
  // desktop transcript does not have; its wildcard admits http(s) and the few
  // protocols it calls safe, and `SafeLink` narrows that to https.
  configured(defaultRehypePlugins['harden'], (defaults) => ({
    ...defaults,
    allowedLinkPrefixes: ['*'],
    allowedProtocols: [],
    allowedImagePrefixes: [],
    allowDataImages: false,
  })),
];

const EMPTY_BOTS: readonly MentionBot[] = [];
const SOFT_BREAKS = remarkSoftBreaks();

/** A link the operator can follow: https only, opened by the system browser. */
function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <ExternalLink
      href={href}
      className="text-accent underline decoration-accent/40 underline-offset-2"
    >
      {children}
    </ExternalLink>
  );
}

function MentionButton({
  bot,
  children,
  onBotMention,
}: {
  bot: MentionBot;
  children: ReactNode;
  onBotMention: ((botId: string) => void) | undefined;
}) {
  const t = useT();
  const clickable = onBotMention !== undefined;
  const palette = useMemo(() => botAccentTokens(bot.avatarColor), [bot.avatarColor]);
  return (
    <button
      type="button"
      data-bot-mention={bot.id}
      disabled={!clickable}
      title={clickable ? t('mention.open', { name: bot.name }) : undefined}
      className="mx-0.5 inline rounded-md px-1 py-0.5 font-semibold outline-none transition-[background-color,box-shadow] hover:brightness-95 focus-visible:ring-2 focus-visible:ring-focus/60 disabled:cursor-default"
      style={
        {
          '--mention-color': palette['--accent'],
          '--mention-ink-light': palette['--bot-accent-ink-light'],
          '--mention-ink-dark': palette['--bot-accent-ink-dark'],
        } as CSSProperties
      }
      onClick={() => onBotMention?.(bot.id)}
    >
      {children}
    </button>
  );
}

/**
 * Safe Markdown for settled and in-flight transcript text, on Streamdown.
 * While `streaming`, Streamdown repairs incomplete Markdown (an open fence is
 * already a code block) and memoizes settled blocks, so a new token
 * re-renders only the block it lands in. Settled text renders as written.
 */
export function StreamingMarkdown({
  source,
  className,
  mentionBots,
  onBotMention,
  streaming = false,
}: StreamingMarkdownProps) {
  const t = useT();
  const locale = useLocale();
  const bots = mentionBots ?? EMPTY_BOTS;
  const remarkPlugins = useMemo<Pluggable[]>(
    () => [
      ...Object.values(defaultRemarkPlugins),
      SOFT_BREAKS,
      ...(bots.length === 0 ? [] : [remarkBotMentions(bots)]),
    ],
    [bots],
  );
  const components = useMemo(
    () =>
      ({
        a: SafeLink,
        // Streamdown draws bold as a styled span; a screen reader hears <strong>.
        strong: ({ children }: { children?: ReactNode }) => (
          <strong className="font-semibold">{children}</strong>
        ),
        img: ({ alt }: { alt?: string }) => (
          <span data-markdown-image className="text-muted-foreground">
            {alt === undefined || alt === ''
              ? t('markdown.image')
              : t('markdown.imageNamed', { alt })}
          </span>
        ),
        mention: ({ botid, children }: { botid?: string; children?: ReactNode }) => {
          const bot = bots.find((candidate) => candidate.id === botid);
          return bot === undefined ? (
            <span>{children}</span>
          ) : (
            <MentionButton bot={bot} onBotMention={onBotMention}>
              {children}
            </MentionButton>
          );
        },
      }) as Components,
    [bots, onBotMention, locale],
  );
  const translations = useMemo<StreamdownTranslations>(
    () => ({
      copyCode: t('markdown.controls.copyCode'),
      downloadFile: t('markdown.controls.downloadFile'),
      downloadDiagram: t('markdown.controls.downloadDiagram'),
      downloadDiagramAsSvg: t('markdown.controls.downloadDiagramAsSvg'),
      downloadDiagramAsPng: t('markdown.controls.downloadDiagramAsPng'),
      downloadDiagramAsMmd: t('markdown.controls.downloadDiagramAsMmd'),
      viewFullscreen: t('markdown.controls.viewFullscreen'),
      exitFullscreen: t('markdown.controls.exitFullscreen'),
      mermaidFormatSvg: 'SVG',
      mermaidFormatPng: 'PNG',
      mermaidFormatMmd: 'MMD',
      zoomIn: t('markdown.controls.zoomIn'),
      zoomOut: t('markdown.controls.zoomOut'),
      resetView: t('markdown.controls.resetView'),
      copyTable: t('markdown.controls.copyTable'),
      copyTableAsMarkdown: t('markdown.controls.copyTableAsMarkdown'),
      copyTableAsCsv: t('markdown.controls.copyTableAsCsv'),
      copyTableAsTsv: t('markdown.controls.copyTableAsTsv'),
      downloadTable: t('markdown.controls.downloadTable'),
      downloadTableAsCsv: t('markdown.controls.downloadTableAsCsv'),
      downloadTableAsMarkdown: t('markdown.controls.downloadTableAsMarkdown'),
      tableFormatMarkdown: 'Markdown',
      tableFormatCsv: 'CSV',
      tableFormatTsv: 'TSV',
      imageNotAvailable: t('markdown.controls.imageNotAvailable'),
      downloadImage: t('markdown.controls.downloadImage'),
      openExternalLink: t('markdown.controls.openExternalLink'),
      externalLinkWarning: t('markdown.controls.externalLinkWarning'),
      close: t('markdown.controls.close'),
      copyLink: t('markdown.controls.copyLink'),
      copied: t('markdown.controls.copied'),
      openLink: t('markdown.controls.openLink'),
    }),
    // `t` tracks `locale`; memoizing prevents Streamdown prop churn per token.
    [locale, t],
  );
  const rootClassName = ['min-w-0', 'break-words', className].filter(Boolean).join(' ');
  return (
    <div data-markdown-renderer="streaming" className={rootClassName}>
      {source === '' ? (
        <span data-markdown-empty aria-hidden="true" />
      ) : (
        <Streamdown
          mode={streaming ? 'streaming' : 'static'}
          parseIncompleteMarkdown={streaming}
          remarkPlugins={remarkPlugins}
          rehypePlugins={REHYPE_PLUGINS}
          components={components}
          plugins={{ code: codeHighlighter }}
          controls={{ code: true, table: true }}
          translations={translations}
          linkSafety={{ enabled: false }}
        >
          {source}
        </Streamdown>
      )}
    </div>
  );
}
