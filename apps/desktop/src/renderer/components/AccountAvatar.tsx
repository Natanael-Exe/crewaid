import { useState } from 'react';

/**
 * The signed-in person's face, or their initials when there is no face to show.
 *
 * One component for every place the account appears, so the sidebar row, the
 * menu header and Settings cannot disagree about who is signed in.
 *
 * The photo is a third-party URL, so it can fail after the session is fine: an
 * expired Google link, a revoked GitHub avatar, no network. The failure is
 * remembered per address, and the initials take its place rather than the
 * browser's broken-image glyph — a new address (a different account signing in)
 * gets its own attempt.
 *
 * `referrerPolicy="no-referrer"` because Google's avatar host refuses some
 * requests that carry one, and there is nothing a referrer would tell it that
 * it needs to know.
 */
export function AccountAvatar({
  initials,
  image,
  className,
}: {
  initials: string;
  image: string | undefined;
  /** Size and type scale; the shape and colours are fixed here. */
  className: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = image !== undefined && failed !== image;

  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full bg-background-tertiary font-medium text-muted ${className}`}
    >
      {showImage ? (
        <img
          src={image}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
          className="size-full object-cover"
          onError={() => setFailed(image)}
        />
      ) : (
        initials
      )}
    </span>
  );
}
