import { describe, expect, it, vi } from 'vitest';
import { createSessionEndedHandler } from './session-ended';

function setup(path: string, clearCookie: () => Promise<unknown> = () => Promise.resolve()) {
  const navigate = vi.fn<(url: string) => void>();
  const clear = vi.fn(clearCookie);
  const {
    handle: handler,
    suppress,
    resume,
  } = createSessionEndedHandler({
    currentPath: () => path,
    clearCookie: clear,
    navigate,
  });
  return { handler, suppress, resume, navigate, clear };
}

describe('the browser handler for an ended session', () => {
  it('clears the cookie, then goes to sign-in with the reason and the place', async () => {
    const { handler, navigate, clear } = setup('/deals');
    handler();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/sign-in?reason=session-ended&returnTo=%2Fdeals');
  });

  it('acts once however many calls fail together', async () => {
    const { handler, navigate, clear } = setup('/dashboard');
    for (let i = 0; i < 237; i += 1) handler();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('still sends the person to sign-in when clearing the cookie fails', async () => {
    const { handler, navigate } = setup('/contacts', () => Promise.reject(new Error('offline')));
    handler();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  });

  it('does nothing on a signed-out screen, which would reload forever', async () => {
    for (const path of ['/sign-in', '/sign-up', '/forgot-password', '/accept-invite/x']) {
      const { handler, navigate, clear } = setup(path);
      handler();
      await Promise.resolve();
      expect(navigate).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
    }
  });

  it('says nothing after the person signed out themselves, until somebody signs in again', async () => {
    const { handler, suppress, resume, navigate, clear } = setup('/contacts');
    suppress();
    handler();
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();

    resume();
    handler();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  });
});
