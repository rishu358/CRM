import { whatsAppTarget } from '@crm/core/whatsapp';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WhatsAppChat } from './whatsapp-chat';

/**
 * The chat control as the browser is handed it. Rendered to markup (no DOM is
 * needed: the control has no state), then the attributes that matter are read
 * back: where it points, that it opens a new tab safely, and what a screen
 * reader is told.
 */
function render(name: string, record: { whatsapp?: string | null; phone?: string | null }) {
  return renderToStaticMarkup(
    createElement(WhatsAppChat, { name, target: whatsAppTarget(record) }),
  );
}

function attribute(markup: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(markup);
  const raw = match?.[1];
  return raw === undefined ? null : raw.replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
}

describe('WhatsAppChat', () => {
  it('links to the WhatsApp number, in a new tab, safely', () => {
    const markup = render('Asha Rao', { whatsapp: '+919876543210', phone: '+14155552671' });
    expect(attribute(markup, 'href')).toBe('https://wa.me/919876543210');
    expect(attribute(markup, 'target')).toBe('_blank');
    expect(attribute(markup, 'rel')).toBe('noopener noreferrer');
    expect(markup).toContain('data-source="whatsapp"');
  });

  it('names the person and the number used, for screen readers and the tooltip', () => {
    const markup = render('Asha Rao', { whatsapp: '+919876543210' });
    const label = attribute(markup, 'aria-label') ?? '';
    expect(label).toContain('Asha Rao');
    expect(label).toContain('WhatsApp number +919876543210');
    expect(label).toContain('new tab');
    expect(attribute(markup, 'title')).toBe('Uses the WhatsApp number +919876543210.');
  });

  it('falls back to the phone number and says so', () => {
    const markup = render('Asha Rao', { whatsapp: null, phone: '+14155552671' });
    expect(attribute(markup, 'href')).toBe('https://wa.me/14155552671');
    expect(markup).toContain('data-source="phone"');
    expect(attribute(markup, 'aria-label')).toContain('phone number +14155552671');
    expect(attribute(markup, 'aria-label')).toContain('no WhatsApp number is saved');
    expect(attribute(markup, 'title')).toContain('no WhatsApp number is saved');
  });

  it('has a visible word, not only an icon, and hides the icon from screen readers', () => {
    const markup = render('Asha Rao', { phone: '+919876543210' });
    expect(markup).toContain('>WhatsApp</a>');
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('falls back to a plain word when the record has no name', () => {
    expect(attribute(render('  ', { phone: '+919876543210' }), 'aria-label')).toContain(
      'Chat with this person',
    );
  });

  it('shows nothing when there is no number', () => {
    expect(render('Asha Rao', {})).toBe('');
    expect(render('Asha Rao', { whatsapp: null, phone: '' })).toBe('');
  });

  it('shows a hint, and no link, when the number is not valid', () => {
    for (const bad of ['98765 43210', '+1', 'javascript:alert(1)', '+91 98765 43210']) {
      const markup = render('Asha Rao', { phone: bad });
      expect(markup).toContain('data-testid="whatsapp-invalid"');
      expect(markup).toContain('international format');
      expect(markup).not.toContain('<a');
      expect(markup).not.toContain('href');
    }
  });

  it('does not use the phone when the WhatsApp number is there but wrong', () => {
    const markup = render('Asha Rao', { whatsapp: '98765', phone: '+14155552671' });
    expect(markup).toContain('data-testid="whatsapp-invalid"');
    expect(markup).not.toContain('wa.me');
  });

  it('never lets a name break out of the attribute it is placed in', () => {
    const markup = render('"><img src=x onerror=alert(1)>', { phone: '+919876543210' });
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&quot;&gt;&lt;img');
  });
});
