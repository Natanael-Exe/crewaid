import { HealthResponseSchema } from '@crewaid/shared';

/**
 * Which release a self-hosted server runs, asked of its `GET /health`.
 *
 * Unauthenticated and outside `/api/v1` (main.ts excludes it from the prefix),
 * which is why this is a plain fetch rather than an `ApiClient` route. `null`
 * for anything that is not a well-formed answer — an older server whose health
 * body has no version, an unreachable one — because the notice it feeds is
 * advice, and advice built on a guess is worse than none.
 */
export async function fetchServerVersion(baseUrl: string): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/health`);
    if (!response.ok) return null;
    const parsed = HealthResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.version : null;
  } catch {
    return null;
  }
}

/**
 * Whether the server is an older release than the app. A self-hosted app
 * updates itself; its server updates when its operator runs the installer, so
 * the two drift, and a newer app may speak to routes an older server lacks.
 *
 * `false` whenever either side is not a plain release (`dev`, a prerelease
 * build, garbage): a notice is only worth showing when it is certainly true.
 */
export function serverIsOlder(server: string, app: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const s = parse(server);
  const a = parse(app);
  if (s === null || a === null) return false;
  for (let i = 0; i < 3; i++) if (s[i] !== a[i]) return (s[i] ?? 0) < (a[i] ?? 0);
  return false;
}
