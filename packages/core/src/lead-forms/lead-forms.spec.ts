import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '../fields/types.js';
import {
  HONEYPOT_FIELD,
  buildSubmissionSchema,
  callingCodeForLocale,
  checkFormFields,
  cleanText,
  isAllowedRedirect,
  isFormKeyShape,
  isFormOfferable,
  normalizeOrigin,
  normalizeOrigins,
  normalizePhone,
  offerableFormFields,
  splitSubmission,
  toPublicIssues,
  type FormFieldSetting,
} from './index.js';
import {
  checkFillToken,
  deriveFillTokenSecret,
  formKeyHint,
  generateFormKey,
  hashFormKey,
  hashSubmissionKey,
  isSubmissionKey,
  issueFillToken,
} from './token.js';

function field(
  key: string,
  type: FieldDefinition['type'],
  extra: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    key,
    label: key,
    type,
    required: false,
    isSystem: false,
    isActive: true,
    position: 0,
    ...extra,
  };
}

const DEFINITIONS: FieldDefinition[] = [
  field('first_name', 'text', { isSystem: true, position: 10 }),
  field('last_name', 'text', { isSystem: true, required: true, position: 20 }),
  field('company', 'text', { isSystem: true, position: 30 }),
  field('email', 'email', { isSystem: true, position: 40 }),
  field('phone', 'phone', { isSystem: true, position: 50 }),
  field('source', 'picklist', {
    isSystem: true,
    position: 60,
    options: [{ value: 'web_form', label: 'Web form' }],
  }),
  field('status', 'picklist', { isSystem: true, position: 70 }),
  field('owner_id', 'user_lookup', { isSystem: true, position: 80 }),
  field('city', 'text', { position: 100 }),
  field('notes', 'long_text', { position: 110 }),
  field('budget', 'number', { position: 120 }),
  field('interest', 'picklist', {
    position: 130,
    options: [
      { value: 'gold', label: 'Gold' },
      { value: 'silver', label: 'Silver', isActive: false },
    ],
  }),
  field('old', 'text', { isActive: false, position: 140 }),
  field('price', 'currency', { position: 150 }),
];

const FIELDS: FormFieldSetting[] = [
  { key: 'last_name', label: 'Your name', required: true },
  { key: 'email', label: 'Email', required: false },
  { key: 'phone', label: 'Phone', required: false },
  { key: 'city', label: 'City', required: false },
];

const BASE = { consent: true, fillToken: 'x' };

function schema(fields: FormFieldSetting[] = FIELDS, code: string | null = '91') {
  return buildSubmissionSchema({ fields, phoneCountryCode: code }, DEFINITIONS);
}

describe('which fields a form may offer', () => {
  it('offers the five standard fields and active custom fields of a safe type', () => {
    expect(offerableFormFields(DEFINITIONS).map((d) => d.key)).toEqual([
      'first_name',
      'last_name',
      'company',
      'email',
      'phone',
      'city',
      'notes',
      'budget',
      'interest',
    ]);
  });

  it.each(['source', 'status', 'owner_id', 'old', 'price'])('never offers %s', (key) => {
    const definition = DEFINITIONS.find((d) => d.key === key);
    expect(definition && isFormOfferable(definition)).toBe(false);
  });

  it('needs the surname required and a way to reach the person', () => {
    expect(checkFormFields(FIELDS, DEFINITIONS)).toEqual([]);
    expect(
      checkFormFields([{ key: 'last_name', label: 'N', required: true }], DEFINITIONS).map(
        (i) => i.message,
      ),
    ).toEqual(['A form must ask for an email or a phone number']);
    expect(
      checkFormFields(
        [
          { key: 'last_name', label: 'N', required: false },
          { key: 'email', label: 'E', required: false },
        ],
        DEFINITIONS,
      ).map((i) => i.message),
    ).toEqual(['A form must ask for the last name, and require it']);
  });

  it('refuses a duplicate, an unknown, a retired and a system field', () => {
    const issues = checkFormFields(
      [
        ...FIELDS,
        { key: 'email', label: 'again', required: false },
        { key: 'nope', label: 'x', required: false },
        { key: 'old', label: 'x', required: false },
        { key: 'status', label: 'x', required: false },
      ],
      DEFINITIONS,
    );
    expect(issues.map((i) => i.path)).toEqual([
      'fields.4.key',
      'fields.5.key',
      'fields.6.key',
      'fields.7.key',
    ]);
  });

  it('makes the form ask for a field the workspace requires on every lead', () => {
    const required = [...DEFINITIONS, field('region', 'text', { required: true, position: 160 })];
    expect(checkFormFields(FIELDS, required).map((i) => i.message)).toEqual([
      'This workspace requires "region" on every lead, so the form must ask for it and require it',
    ]);
    expect(
      checkFormFields([...FIELDS, { key: 'region', label: 'Region', required: true }], required),
    ).toEqual([]);
  });

  it('caps a form at 25 fields', () => {
    const many = Array.from({ length: 26 }, () => FIELDS[0]!);
    expect(checkFormFields(many, DEFINITIONS).some((i) => i.message.includes('at most 25'))).toBe(
      true,
    );
  });
});

describe('origins', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['https://Shop.Example.com/', 'https://shop.example.com'],
    ['  https://example.com:8443 ', 'https://example.com:8443'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it.each([
    'http://example.com',
    'https://*.example.com',
    '*',
    'https://example.com/path',
    'https://example.com?x=1',
    'https://example.com#frag',
    'https://user:pw@example.com',
    'https://localhost',
    'https://10.0.0.1',
    'https://[::1]',
    'javascript:alert(1)',
    'example.com',
    '',
    'https://example.com\\evil.com',
    'https://exa mple.com',
  ])('refuses %j', (input) => {
    expect(normalizeOrigin(input)).toBeNull();
  });

  it('admits local http origins only when asked', () => {
    expect(normalizeOrigin('http://localhost:3000')).toBeNull();
    expect(normalizeOrigin('http://localhost:3000', { allowLocal: true })).toBe(
      'http://localhost:3000',
    );
    expect(normalizeOrigin('http://evil.example', { allowLocal: true })).toBeNull();
  });

  it('removes duplicates and reports the bad ones by position', () => {
    expect(
      normalizeOrigins(['https://a.example', 'https://A.example/', 'nope', 'https://b.example']),
    ).toEqual({
      origins: ['https://a.example', 'https://b.example'],
      invalid: [2],
    });
  });

  it('only redirects to a page on an allowed origin', () => {
    const allowed = ['https://shop.example'];
    expect(isAllowedRedirect('https://shop.example/thanks', allowed)).toBe(true);
    expect(isAllowedRedirect('https://other.example/thanks', allowed)).toBe(false);
    expect(isAllowedRedirect('http://shop.example/thanks', allowed)).toBe(false);
    expect(isAllowedRedirect('https://shop.example@evil.example/', allowed)).toBe(false);
    expect(isAllowedRedirect('https://shop.example/a b', allowed)).toBe(false);
    expect(isAllowedRedirect('javascript:alert(1)', allowed)).toBe(false);
  });
});

describe('cleanText', () => {
  it('keeps markup as text and trims', () => {
    expect(cleanText('  <script>alert(1)</script> ', { multiline: false })).toBe(
      '<script>alert(1)</script>',
    );
  });

  it.each(['a\u0000b', 'a\u0007b', 'a‮b', 'a⁦b', 'a\u007Fb', '\ud800', 'x\udc00y'])(
    'refuses %j',
    (value) => {
      expect(cleanText(value, { multiline: true })).toBeNull();
    },
  );

  it('turns a tab or line break in a one-line field into a space, and keeps them in a long one', () => {
    expect(cleanText('a\nb\tc', { multiline: false })).toBe('a b c');
    expect(cleanText('a\r\nb', { multiline: true })).toBe('a\nb');
  });

  it('normalises to NFC', () => {
    expect(cleanText('é', { multiline: false })).toBe('é');
  });
});

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '91', '+919876543210'],
    ['09876543210', '91', '+919876543210'],
    ['98765 43210', '91', '+919876543210'],
    ['+91 98765-43210', null, '+919876543210'],
    ['(+91) 98765.43210', null, '+919876543210'],
    ['919876543210', '91', '+919876543210'],
    ['00919876543210', '91', '+919876543210'],
    ['+14155552671', '91', '+14155552671'],
    ['4155552671', '1', '+14155552671'],
  ])('%s with %s is %s', (input, code, expected) => {
    expect(normalizePhone(input, code)).toBe(expected);
  });

  it.each([
    ['1234567890', '91'],
    ['12345', '91'],
    ['abc', '91'],
    ['', '91'],
    ['9876543210', null],
    ['+0123456789', null],
    ['+91 5876543210', null],
    ['9876543210123456789012345', '91'],
    ['98765\u00004321', '91'],
    [`+1${'2'.repeat(15)}`, null],
  ])('refuses %j with %s', (input, code) => {
    expect(normalizePhone(input, code)).toBeNull();
  });
});

describe('the submission schema', () => {
  it('accepts a complete submission and returns cleaned values', () => {
    const result = schema().safeParse({
      ...BASE,
      last_name: '  Rao ',
      email: 'Asha@Example.COM',
      phone: '98765 43210',
      city: 'Kolkata',
      [HONEYPOT_FIELD]: '',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      last_name: 'Rao',
      email: 'asha@example.com',
      phone: '+919876543210',
      city: 'Kolkata',
    });
  });

  it('refuses any key the form does not ask for', () => {
    const extras = [
      'tenantId',
      'tenant_id',
      'userId',
      'ownerId',
      'owner_id',
      'status',
      'source',
      'version',
      'id',
      '__proto__',
      'constructor',
      'company',
    ];
    for (const key of extras) {
      const body = JSON.parse(
        `{"consent":true,"fillToken":"x","last_name":"Rao","email":"a@b.example","${key}":"x"}`,
      ) as unknown;
      expect(schema().safeParse(body).success, key).toBe(false);
    }
  });

  it('needs consent to be exactly true', () => {
    for (const consent of [false, 'true', 1, null, undefined, 'on']) {
      expect(
        schema().safeParse({ fillToken: 'x', last_name: 'Rao', email: 'a@b.example', consent })
          .success,
      ).toBe(false);
    }
  });

  it('needs an email or a phone when the form asks for either', () => {
    expect(schema().safeParse({ ...BASE, last_name: 'Rao' }).success).toBe(false);
    expect(schema().safeParse({ ...BASE, last_name: 'Rao', phone: '9876543210' }).success).toBe(
      true,
    );
    expect(
      schema().safeParse({ ...BASE, last_name: 'Rao', email: '', phone: '9876543210' }).success,
    ).toBe(true);
  });

  it('refuses junk addresses', () => {
    for (const email of [
      'a',
      'a@b',
      'a@b.c',
      '@b.example',
      'a b@c.example',
      'a@@b.example',
      'a@b\n.example',
    ]) {
      expect(schema().safeParse({ ...BASE, last_name: 'Rao', email }).success, email).toBe(false);
    }
  });

  it('trims whitespace around an address, like everywhere else', () => {
    const result = schema().safeParse({ ...BASE, last_name: 'Rao', email: ' A@B.example\n' });
    expect(result.success && result.data['email']).toBe('a@b.example');
  });

  it('caps every value, and a 10,000-character value is refused, not truncated', () => {
    const huge = 'a'.repeat(10_000);
    for (const key of ['last_name', 'email', 'phone', 'city']) {
      const body: Record<string, unknown> = {
        ...BASE,
        last_name: 'Rao',
        email: 'a@b.example',
        [key]: huge,
      };
      expect(schema().safeParse(body).success, key).toBe(false);
    }
    expect(
      schema().safeParse({ ...BASE, last_name: 'a'.repeat(121), email: 'a@b.example' }).success,
    ).toBe(false);
    expect(
      schema().safeParse({ ...BASE, last_name: 'a'.repeat(120), email: 'a@b.example' }).success,
    ).toBe(true);
  });

  it('stores markup as text', () => {
    const result = schema().safeParse({
      ...BASE,
      last_name: '<img src=x onerror=alert(1)>',
      email: 'a@b.example',
    });
    expect(result.success && result.data['last_name']).toBe('<img src=x onerror=alert(1)>');
  });

  it('checks custom field types', () => {
    const fields: FormFieldSetting[] = [
      ...FIELDS,
      { key: 'budget', label: 'B', required: false },
      { key: 'interest', label: 'I', required: true },
      { key: 'notes', label: 'N', required: false },
    ];
    const s = schema(fields);
    const ok = {
      ...BASE,
      last_name: 'Rao',
      email: 'a@b.example',
      interest: 'gold',
      budget: 5000,
      notes: 'x\ny',
    };
    expect(s.safeParse(ok).success).toBe(true);
    expect(s.safeParse({ ...ok, interest: 'silver' }).success).toBe(false);
    expect(s.safeParse({ ...ok, interest: 'nope' }).success).toBe(false);
    expect(s.safeParse({ ...ok, interest: undefined }).success).toBe(false);
    expect(s.safeParse({ ...ok, budget: '5000' }).success).toBe(false);
    expect(s.safeParse({ ...ok, budget: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(s.safeParse({ ...ok, notes: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('turns failures into fixed sentences that never repeat what was sent', () => {
    const marker = 'SECRET-MARKER-12345';
    const result = schema().safeParse({
      ...BASE,
      last_name: 'Rao',
      email: marker,
      [marker]: marker,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = toPublicIssues(result.error, ['last_name', 'email', 'phone', 'city']);
    expect(JSON.stringify(issues)).not.toContain(marker);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('splits standard columns from custom fields', () => {
    expect(
      splitSubmission(
        { last_name: 'Rao', email: 'a@b.example', city: 'Pune', phone: undefined },
        FIELDS,
      ),
    ).toEqual({
      standard: { lastName: 'Rao', email: 'a@b.example' },
      customFields: { city: 'Pune' },
    });
  });
});

/** A small seeded generator, so a failure can be replayed. No dependency (CLAUDE.md §11.4). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('fuzzing the schema', () => {
  const pieces = [
    '<',
    '>',
    '"',
    "'",
    '`',
    '\u0000',
    '‮',
    '\ud800',
    '\n',
    '\t',
    ' ',
    '＠',
    '@',
    '.',
    '+',
    '=',
    '%00',
    '${x}',
    '{{x}}',
    '../',
    'é',
    '日本',
    '😀',
    '0',
    '9',
    'a',
  ];
  const keys = [
    'consent',
    'fillToken',
    'last_name',
    'email',
    'phone',
    'city',
    'company',
    'tenantId',
    '__proto__',
    'constructor',
    'toString',
    'x'.repeat(300),
    HONEYPOT_FIELD,
  ];

  function randomValue(next: () => number, depth = 0): unknown {
    const pick = Math.floor(next() * 9);
    switch (pick) {
      case 0:
        return null;
      case 1:
        return next() < 0.5;
      case 2:
        return (next() - 0.5) * 10 ** Math.floor(next() * 30);
      case 3:
        return Array.from({ length: Math.floor(next() * 4) }, () => randomValue(next, depth + 1));
      case 4:
        return depth > 2
          ? 'x'
          : Object.fromEntries(
              Array.from({ length: Math.floor(next() * 3) }, () => [
                keys[Math.floor(next() * keys.length)]!,
                randomValue(next, depth + 1),
              ]),
            );
      default: {
        const length = Math.floor(next() * (next() < 0.1 ? 3000 : 40));
        let text = '';
        for (let i = 0; i < length; i += 1) text += pieces[Math.floor(next() * pieces.length)];
        return text;
      }
    }
  }

  function randomBody(next: () => number): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const count = Math.floor(next() * 7);
    for (let i = 0; i < count; i += 1) {
      Object.defineProperty(body, keys[Math.floor(next() * keys.length)]!, {
        value: randomValue(next),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return body;
  }

  it('never throws, never lets in an unknown key, and never exceeds a cap', () => {
    const s = schema();
    const next = random(20261028);
    const allowedOut = [
      'consent',
      'fillToken',
      HONEYPOT_FIELD,
      'last_name',
      'email',
      'phone',
      'city',
    ];
    for (let run = 0; run < 3000; run += 1) {
      const result = s.safeParse(randomBody(next));
      if (!result.success) continue;
      const data = result.data as Record<string, unknown>;
      expect(Object.keys(data).every((key) => allowedOut.includes(key))).toBe(true);
      expect(String(data['last_name']).length).toBeLessThanOrEqual(120);
      if (data['email'] !== undefined)
        expect(String(data['email']).length).toBeLessThanOrEqual(254);
      if (data['phone'] !== undefined) expect(String(data['phone'])).toMatch(/^\+[1-9]\d{1,14}$/);
      if (data['city'] !== undefined) expect(String(data['city']).length).toBeLessThanOrEqual(500);
    }
  });

  it('mutating one field of a good body keeps the same guarantees', () => {
    const s = schema();
    const next = random(7);
    for (let run = 0; run < 1500; run += 1) {
      const body: Record<string, unknown> = {
        ...BASE,
        last_name: 'Rao',
        email: 'a@b.example',
        city: 'Pune',
      };
      body[['last_name', 'email', 'city', 'phone'][Math.floor(next() * 4)]!] = randomValue(next);
      const result = s.safeParse(body);
      if (!result.success) continue;
      const data = result.data as Record<string, unknown>;
      expect(String(data['last_name']).length).toBeLessThanOrEqual(120);
      expect(typeof data['last_name']).toBe('string');
    }
  });
});

describe('keys and tokens', () => {
  it('a key is 256 bits, has the expected shape, and is hashed to 32 bytes', () => {
    const key = generateFormKey();
    expect(isFormKeyShape(key)).toBe(true);
    expect(key).toHaveLength(47);
    expect(hashFormKey(key)).toHaveLength(32);
    expect(formKeyHint(key)).toBe(key.slice(-4));
    expect(generateFormKey()).not.toBe(key);
  });

  it.each([
    '',
    'lfk_',
    `lfk_${'a'.repeat(42)}`,
    `lfk_${'a'.repeat(44)}`,
    `xxx_${'a'.repeat(43)}`,
    `lfk_${'!'.repeat(43)}`,
    `lfk_${'a'.repeat(43)}\n`,
  ])('does not take %j for a key', (value) => {
    expect(isFormKeyShape(value)).toBe(false);
  });

  it('refuses a key of the wrong shape rather than hashing it', () => {
    expect(() => hashFormKey('nope')).toThrow(TypeError);
    expect(() => generateFormKey(Buffer.alloc(31))).toThrow(RangeError);
  });

  it('a submission key is scoped to its form', () => {
    expect(hashSubmissionKey('f1', 'k').equals(hashSubmissionKey('f2', 'k'))).toBe(false);
    expect(hashSubmissionKey('f1', 'k').equals(hashSubmissionKey('f1', 'k'))).toBe(true);
    expect(isSubmissionKey('abc_1.2:3-4')).toBe(true);
    expect(isSubmissionKey('a b')).toBe(false);
    expect(isSubmissionKey('a'.repeat(129))).toBe(false);
  });

  it('a fill token is valid between 3 seconds and 4 hours, for its own form only', () => {
    const secret = deriveFillTokenSecret('a-test-secret-that-is-long-enough-123456');
    const at = new Date('2026-10-28T10:00:00Z');
    const token = issueFillToken(secret, 'form-1', at);
    const later = (seconds: number) => new Date(at.getTime() + seconds * 1000);

    expect(checkFillToken(secret, 'form-1', token, later(0))).toBe('too_fast');
    expect(checkFillToken(secret, 'form-1', token, later(2))).toBe('too_fast');
    expect(checkFillToken(secret, 'form-1', token, later(3))).toBe('ok');
    expect(checkFillToken(secret, 'form-1', token, later(4 * 3600))).toBe('ok');
    expect(checkFillToken(secret, 'form-1', token, later(4 * 3600 + 1))).toBe('expired');
    expect(checkFillToken(secret, 'form-2', token, later(10))).toBe('invalid');
    expect(
      checkFillToken(
        deriveFillTokenSecret('another-secret-that-is-long-enough-123'),
        'form-1',
        token,
        later(10),
      ),
    ).toBe('invalid');
  });

  it.each([
    undefined,
    null,
    1,
    '',
    'v1',
    'v1.1.x',
    `v1.${'9'.repeat(13)}.${'a'.repeat(43)}`,
    'x'.repeat(300),
  ])('treats %j as an invalid token', (token) => {
    const secret = deriveFillTokenSecret('a-test-secret-that-is-long-enough-123456');
    expect(checkFillToken(secret, 'form-1', token, new Date())).toBe('invalid');
  });

  it('a tampered issue time does not verify', () => {
    const secret = deriveFillTokenSecret('a-test-secret-that-is-long-enough-123456');
    const at = new Date('2026-10-28T10:00:00Z');
    const token = issueFillToken(secret, 'form-1', at);
    const parts = token.split('.');
    const forged = `v1.${Number(parts[1]) - 3600}.${parts[2]}`;
    expect(checkFillToken(secret, 'form-1', forged, new Date(at.getTime() + 10_000))).toBe(
      'invalid',
    );
  });
});

describe('locale pre-fill', () => {
  it('reads the region of a locale', () => {
    expect(callingCodeForLocale('en-IN')).toBe('91');
    expect(callingCodeForLocale('en')).toBeNull();
    expect(callingCodeForLocale('xx-ZZ')).toBeNull();
  });
});
