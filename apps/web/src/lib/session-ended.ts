import { SIGN_IN_PATH, isPublicPath, signInQuery } from './session-gate';

/**
 * What the browser does when the API says the session is gone while the app is open (ADR-0055).
 *
 * One place for it, called by the two functions every request goes through (`api-client.ts` and
 * `session.ts`), instead of a handler in each widget. The dashboard alone makes about seven calls at
 * once, so it acts only the first time. Nothing here decides who may see what; the API has already
 * refused, and this only stops showing a screen full of errors for a person who needs to sign in.
 */
export interface SessionEndedDeps {
  readonly currentPath: () => string;
  /** Clear the httpOnly cookie, which only the server can do. May fail; the redirect happens anyway. */
  readonly clearCookie: () => Promise<unknown>;
  readonly navigate: (url: string) => void;
}

export interface SessionEndedHandler {
  /** The API said the session is gone. */
  readonly handle: () => void;
  /**
   * The person chose to sign out. Whatever is still in flight will now be refused, and that is not
   * "your session has ended", so say nothing until somebody signs in again.
   */
  readonly suppress: () => void;
  /** Somebody signed in: a later refusal is news again. */
  readonly resume: () => void;
}

export function createSessionEndedHandler(deps: SessionEndedDeps): SessionEndedHandler {
  let ending = false;
  let suppressed = false;

  const handle = () => {
    if (ending || suppressed) return;

    const path = deps.currentPath();
    // A 401 on a signed-out screen is that screen's own business, and sending the person back to
    // the page they are already on would reload it forever.
    if (isPublicPath(path)) return;

    ending = true;
    const go = () => deps.navigate(`${SIGN_IN_PATH}${signInQuery(path, { sessionEnded: true })}`);
    deps.clearCookie().then(go, go);
  };

  return {
    handle,
    suppress: () => {
      suppressed = true;
    },
    resume: () => {
      suppressed = false;
    },
  };
}

/**
 * A full page load rather than a client-side navigation, so everything held in memory (the query
 * cache, with one person's records in it) is discarded before anyone else can sign in on this tab.
 */
const browserHandler = createSessionEndedHandler({
  currentPath: () => globalThis.location.pathname,
  clearCookie: () =>
    globalThis.fetch('/api/session', { method: 'DELETE', signal: AbortSignal.timeout(3000) }),
  navigate: (url) => globalThis.location.assign(url),
});

export const handleSessionEnded = browserHandler.handle;
export const suppressSessionEnded = browserHandler.suppress;
export const resumeSessionEnded = browserHandler.resume;
