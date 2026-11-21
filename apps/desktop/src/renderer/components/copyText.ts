/**
 * Copy to the clipboard, from a renderer that may or may not be allowed to.
 *
 * `navigator.clipboard` is the right API and is usually there — a `file://`
 * page is a secure context, so the Electron production build qualifies — but
 * it is gated on a permission the embedder can refuse, and it rejects rather
 * than throwing synchronously. The fallback is the pre-async-clipboard trick:
 * a detached textarea, selected, and `execCommand('copy')`. It is deprecated
 * and it works everywhere, which is the right trade for a button whose whole
 * value is that it never fails silently.
 *
 * Returns whether the text actually landed, so the caller can show the tick
 * only when it did.
 */
export async function copyText(text: string): Promise<boolean> {
  if (text === '') return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyViaTextarea(text);
  }
}

function copyViaTextarea(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    // Off-screen rather than `display:none`: a hidden element cannot be
    // selected, and an unselectable one copies nothing.
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}
