import { describe, expect, it } from 'vitest';
import { companyDomainFromEmail, emailDomain, LEAD_TO_CONTACT_FIELDS } from './index.js';

describe('emailDomain', () => {
  it('takes the part after the last @, lowercased', () => {
    expect(emailDomain('Asha@Rajeshgold.Example')).toBe('rajeshgold.example');
  });

  it('returns null when there is no usable domain', () => {
    for (const value of [null, undefined, '', 'nobody', '@x.com', 'a@']) {
      expect(emailDomain(value)).toBeNull();
    }
  });
});

describe('companyDomainFromEmail', () => {
  it('returns a company domain', () => {
    expect(companyDomainFromEmail('buyer@lotusdesign.example')).toBe('lotusdesign.example');
  });

  it('refuses free-mail domains, which identify a provider and not a company', () => {
    expect(companyDomainFromEmail('someone@gmail.com')).toBeNull();
    expect(companyDomainFromEmail('someone@GMAIL.com')).toBeNull();
    expect(companyDomainFromEmail('someone@rediffmail.com')).toBeNull();
  });
});

describe('LEAD_TO_CONTACT_FIELDS', () => {
  it('maps the lead source onto the contact lead source', () => {
    const source = LEAD_TO_CONTACT_FIELDS.find((entry) => entry.lead.prop === 'source');
    expect(source?.contact).toEqual({ prop: 'leadSource', field: 'lead_source' });
  });

  it('copies only the five agreed fields, and the surname is the only required one', () => {
    expect(LEAD_TO_CONTACT_FIELDS.map((entry) => entry.lead.prop).sort()).toEqual(
      ['email', 'firstName', 'lastName', 'phone', 'source'].sort(),
    );
    expect(
      LEAD_TO_CONTACT_FIELDS.filter((entry) => entry.required).map((e) => e.lead.prop),
    ).toEqual(['lastName']);
  });
});
