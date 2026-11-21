/**
 * Types for `@novnc/novnc`, which ships none.
 *
 * Deliberately NARROW: only the members M2-FE-01 uses. A fuller transcription
 * would be a second, unverified copy of an API we do not control — and the
 * value of declaring it by hand is precisely that adding a call means noticing
 * you added one, rather than `any` making every future call invisible.
 *
 * `RFB`'s second parameter is typed as a `WebSocket` upstream, but noVNC 1.7
 * accepts any object carrying the eight members its `Websock.attach` checks
 * for by name. `rfbChannel.ts` implements exactly those.
 */
declare module '@novnc/novnc' {
  export interface RfbOptions {
    readonly shared?: boolean;
  }

  export default class RFB {
    constructor(target: Element, urlOrChannel: WebSocket | string, options?: RfbOptions);
    /** Suppresses noVNC's own keyboard/pointer capture. */
    viewOnly: boolean;
    /** Client-side scaling. R8 forbids the server-side kind. */
    scaleViewport: boolean;
    /** Would ask the server to change the display size; §5 fixes it. */
    resizeSession: boolean;
    /** Color behind the scaled framebuffer, including letterbox gutters. */
    background: string;
    /**
     * Focuses noVNC's own canvas, which it creates with `tabIndex = -1` — so
     * nothing else can put focus there, and without focus its keyboard grab
     * never fires (M2-FE-03).
     */
    focus(options?: FocusOptions): void;
    disconnect(): void;
    addEventListener(type: string, listener: (event: Event) => void): void;
    removeEventListener(type: string, listener: (event: Event) => void): void;
  }
}
