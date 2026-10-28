import { describe, expect, it } from 'vitest';
import {
  UNVERIFIED_ZOHO_HEADINGS,
  detectTemplate,
  normalizeHeading,
  suggestMapping,
  templateHeadings,
} from './templates.js';

const target = (key: string, label = key) => ({ key, label });

const contactTargets = [
  target('first_name', 'First name'),
  target('last_name', 'Last name'),
  target('email', 'Email'),
  target('phone', 'Phone'),
  target('title', 'Title'),
  target('lead_source', 'Lead source'),
  target('owner_id', 'Owner (e-mail address of a team member)'),
  target('account_id', 'Account (name, domain or ID)'),
];

const dealTargets = [
  target('name', 'Deal name'),
  target('amount', 'Amount'),
  target('expected_close_date', 'Expected close date'),
  target('owner_id', 'Owner (e-mail address of a team member)'),
  target('account_id', 'Account (name, domain or ID)'),
  target('primary_contact_id', 'Primary contact (e-mail address)'),
  target('pipeline_id', 'Pipeline (name; blank means the default pipeline)'),
  target('stage_id', 'Stage (name; blank means the first open stage)'),
  target('external_id', 'Your own ID for the deal'),
];

describe('normalizeHeading', () => {
  it('makes spelling, case and punctuation irrelevant', () => {
    expect(normalizeHeading('Last Name')).toBe('lastname');
    expect(normalizeHeading('last_name')).toBe('lastname');
    expect(normalizeHeading(' E-mail  ')).toBe('email');
  });
});

describe('detectTemplate', () => {
  it('takes two Zoho-style headings as a Zoho export', () => {
    expect(detectTemplate(['Contact Owner', 'First Name', 'Last Name', 'Account Name'])).toBe(
      'zoho',
    );
    expect(detectTemplate(['Deal Name', 'Closing Date', 'Stage'])).toBe('zoho');
  });

  it('takes a plain spreadsheet as generic, and one Zoho-ish heading as not enough', () => {
    expect(detectTemplate(['First name', 'Last name', 'Email'])).toBe('generic');
    expect(detectTemplate(['Name', 'Account Name', 'Phone'])).toBe('generic');
  });
});

describe('suggestMapping', () => {
  it('maps a Zoho contact export by its own labels', () => {
    const headings = [
      'Contact Owner',
      'First Name',
      'Last Name',
      'Account Name',
      'Lead Source',
      'Email',
      'Phone',
    ];
    expect(suggestMapping('contact', headings, contactTargets, 'zoho')).toEqual({
      0: 'owner_id',
      1: 'first_name',
      2: 'last_name',
      3: 'account_id',
      4: 'lead_source',
      5: 'email',
      6: 'phone',
    });
  });

  it('maps a Zoho deal export, and leaves Contact Name alone because it is a name, not an e-mail address', () => {
    const headings = [
      'Deal Owner',
      'Deal Name',
      'Account Name',
      'Contact Name',
      'Amount',
      'Closing Date',
      'Stage',
      'Record Id',
    ];
    const suggested = suggestMapping('deal', headings, dealTargets, 'zoho');
    expect(suggested).toEqual({
      0: 'owner_id',
      1: 'name',
      2: 'account_id',
      4: 'amount',
      5: 'expected_close_date',
      6: 'stage_id',
      7: 'external_id',
    });
    expect(Object.values(suggested)).not.toContain('primary_contact_id');
  });

  it('maps a tidy spreadsheet by the common ways of saying each thing', () => {
    const headings = ['Given name', 'Surname', 'E-mail', 'Mobile', 'Job title', 'Assigned to'];
    expect(suggestMapping('contact', headings, contactTargets, 'generic')).toEqual({
      0: 'first_name',
      1: 'last_name',
      2: 'email',
      3: 'phone',
      4: 'title',
      5: 'owner_id',
    });
  });

  it('does not take a free-text Company column for an account link', () => {
    expect(suggestMapping('contact', ['Last name', 'Company'], contactTargets, 'generic')).toEqual({
      0: 'last_name',
    });
  });

  it('keeps what the screen always did: a heading that is a target label or key wins, and works in every template', () => {
    const headings = ['Last name', 'email'];
    for (const template of ['zoho', 'generic'] as const) {
      expect(suggestMapping('contact', headings, contactTargets, template)).toEqual({
        0: 'last_name',
        1: 'email',
      });
    }
  });

  it('suggests a target once, for the first column that claims it', () => {
    const suggested = suggestMapping(
      'contact',
      ['Email', 'E-mail', 'Email address'],
      contactTargets,
      'generic',
    );
    expect(suggested).toEqual({ 0: 'email' });
  });

  it('never suggests a target the person is not offered', () => {
    const withoutOwner = contactTargets.filter((entry) => entry.key !== 'owner_id');
    expect(suggestMapping('contact', ['Contact Owner', 'Last Name'], withoutOwner, 'zoho')).toEqual(
      {
        1: 'last_name',
      },
    );
    // Original dates are offered only to holders of the right: no target, no suggestion.
    expect(
      suggestMapping('contact', ['Created Time', 'Last Name'], contactTargets, 'zoho'),
    ).toEqual({
      1: 'last_name',
    });
  });

  it('suggests a date column only when it is offered', () => {
    const offered = [...contactTargets, target('created_at', 'Created date (original date)')];
    expect(suggestMapping('contact', ['Created Time'], offered, 'zoho')).toEqual({
      0: 'created_at',
    });
  });

  it('leaves an unrecognised heading unmapped', () => {
    expect(suggestMapping('contact', ['Last Name', 'Shoe size'], contactTargets, 'zoho')).toEqual({
      0: 'last_name',
    });
  });
});

describe('the Zoho headings that are not from its help pages are said to be unverified', () => {
  it('lists exactly the system columns of an export', () => {
    expect([...UNVERIFIED_ZOHO_HEADINGS].sort()).toEqual([
      'Closed Time',
      'Created Time',
      'Record Id',
    ]);
  });
});

describe('templateHeadings', () => {
  it('gives the headings of a blank file, for the targets the person is offered', () => {
    expect(templateHeadings('contact', contactTargets)).toEqual([
      'First name',
      'Last name',
      'Email address',
      'Phone number',
      'Job title',
      'Source',
      'Account',
      'Owner',
    ]);
  });

  it('every heading it gives maps back to its own target in the generic template', () => {
    for (const [objectType, targets] of [
      ['contact', contactTargets],
      ['deal', dealTargets],
    ] as const) {
      const headings = templateHeadings(objectType, targets);
      const suggested = suggestMapping(objectType, headings, targets, 'generic');
      expect(Object.keys(suggested)).toHaveLength(headings.length);
    }
  });
});
