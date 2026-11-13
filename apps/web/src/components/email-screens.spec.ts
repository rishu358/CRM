import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A customer's reply is text a stranger wrote (ADR-0077), so the Emails card must draw it as text, and nothing on
 * the screens that show it may write raw HTML or run a string as code. React escapes a string child;
 * `dangerouslySetInnerHTML` would undo that.
 */
const FILES = ['email-panel.tsx', 'email-settings-page.tsx', 'notification-bell.tsx'].map((name) =>
  join(__dirname, name),
);

describe('the screens that show a reply', () => {
  it.each(FILES.map((file) => [file.slice(file.lastIndexOf('components')), file] as const))(
    '%s never writes raw HTML or runs a string as code',
    (_name, file) => {
      const text = readFileSync(file, 'utf8');
      for (const forbidden of [
        'dangerouslySetInnerHTML',
        'innerHTML',
        'eval(',
        'new Function',
        'document.write',
      ]) {
        expect(text, forbidden).not.toContain(forbidden);
      }
    },
  );

  it('draws a message body inside a <pre> as a string child, so it stays text', () => {
    const text = readFileSync(join(__dirname, 'email-panel.tsx'), 'utf8');
    expect(text).toMatch(
      /<pre[^>]*>\s*\{showQuoted \|\| parts\.quoted === null \? email\.body : parts\.fresh\}\s*<\/pre>/,
    );
  });

  it('puts nothing a customer wrote in the bell: the line is fixed words and the link is built from ids', () => {
    const text = readFileSync(join(__dirname, 'notification-bell.tsx'), 'utf8');
    expect(text).toContain("t('notifications.emailReply')");
    expect(text).toContain('recordPath(notification)');
  });
});
