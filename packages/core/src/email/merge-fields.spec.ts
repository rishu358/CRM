import { describe, expect, it } from 'vitest';
import {
  emptyEmailMergeFields,
  hasControlCharacter,
  isValidSignature,
  isValidTemplateName,
  emailMergeFieldsIn,
  renderEmailMergeFields,
  unknownEmailMergeFields,
} from './merge-fields.js';

describe('merge fields', () => {
  it('finds the names between braces, once each, spaces ignored', () => {
    expect(
      emailMergeFieldsIn('Hi {{contact.first_name}}, {{ contact.first_name }} and {{sender.name}}'),
    ).toEqual(['contact.first_name', 'sender.name']);
    expect(emailMergeFieldsIn('no fields here')).toEqual([]);
  });

  it('calls out a name that is not on the list, including a misspelt or spaced one', () => {
    expect(
      unknownEmailMergeFields('{{contact.first_name}} {{contact.email}} {{ Contact Name }} {{}}'),
    ).toEqual(['contact.email', 'Contact Name', '']);
  });

  it('fills the known fields and leaves nothing for one with no value', () => {
    const values = { 'contact.first_name': 'Anil', 'sender.name': 'Priya' };
    expect(
      renderEmailMergeFields(
        'Hi {{contact.first_name}} {{contact.last_name}}, Priya? {{sender.name}}',
        values,
      ),
    ).toBe('Hi Anil , Priya? Priya');
  });

  it('puts a value in as text, once: braces inside a value are not looked at again', () => {
    const out = renderEmailMergeFields('Hi {{contact.first_name}}', {
      'contact.first_name': '{{sender.name}}',
      'sender.name': 'Secret',
    });
    expect(out).toBe('Hi {{sender.name}}');
  });

  it('puts a value on one line, so a name cannot add a header or a paragraph', () => {
    expect(
      renderEmailMergeFields('{{contact.first_name}}', {
        'contact.first_name': 'A\r\nBcc: x@y.example',
      }),
    ).toBe('A Bcc: x@y.example');
  });

  it('lists the fields a text uses that have no value for this person', () => {
    expect(
      emptyEmailMergeFields('{{contact.first_name}} {{account.name}} {{deal.name}}', {
        'contact.first_name': 'Anil',
        'deal.name': '  ',
      }),
    ).toEqual(['account.name', 'deal.name']);
  });

  it('checks names and signatures', () => {
    expect(isValidTemplateName('Follow-up after demo')).toBe(true);
    expect(isValidTemplateName('')).toBe(false);
    expect(isValidTemplateName('a\nb')).toBe(false);
    expect(isValidTemplateName('x'.repeat(81))).toBe(false);
    expect(isValidSignature('Priya\nSharma Traders')).toBe(true);
    expect(isValidSignature('x'.repeat(501))).toBe(false);
    expect(hasControlCharacter('plain')).toBe(false);
    expect(hasControlCharacter('tab\there')).toBe(true);
  });
});
