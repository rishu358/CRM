import {
  CITIES,
  FIRST_NAMES_F,
  FIRST_NAMES_M,
  NAME_SYLLABLES,
  STREETS,
  SURNAMES,
} from '../data/names.mjs';

/**
 * Made-up people, companies and identifiers. Every value is fictional on purpose:
 *
 * - Emails end in `.example`, a name reserved so it can never be registered or delivered to.
 * - Phone numbers are `+91` followed by a ZERO and nine digits. In India the leading 0 is the dialling
 *   prefix for calls inside the country, not part of a number, so no subscriber can hold a number
 *   that, in international form, starts +910. The API only checks the general E.164 shape, so these
 *   pass its validation. (Whether the telecom regulator reserves any range for fiction was not found;
 *   this choice does not depend on one.)
 * - GSTINs have the right shape and a real state code, and a check character that is deliberately
 *   wrong, so none can be a live registration. The API checks the shape only (a finding).
 */

const ALPHANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The check character a real GSTIN would carry, from its first fourteen characters. */
export function gstinCheckCharacter(first14) {
  let sum = 0;
  for (let index = 0; index < first14.length; index += 1) {
    const value = ALPHANUM.indexOf(first14[index]);
    const product = value * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return ALPHANUM[(36 - (sum % 36)) % 36];
}

export const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function makeGenerator(rng) {
  const usedEmails = new Set();
  const usedPhones = new Set();
  const usedNames = new Set();
  const usedGstins = new Set();

  const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1);

  const gen = {
    person(gender) {
      const female = gender ? gender === 'f' : rng.chance(0.45);
      const first = rng.pick(female ? FIRST_NAMES_F : FIRST_NAMES_M);
      return { firstName: first, lastName: rng.pick(SURNAMES), female };
    },

    /** An invented single word, two to four syllables. */
    root() {
      const count = rng.int(2, 4);
      return capital(Array.from({ length: count }, () => rng.pick(NAME_SYLLABLES)).join(''));
    },

    /** A company name that has not been used yet in this run: "<Root> <Kind>". */
    companyName(kinds) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const name = `${gen.root()} ${rng.pick(kinds)}`;
        if (!usedNames.has(name.toLowerCase())) {
          usedNames.add(name.toLowerCase());
          return name;
        }
      }
      const fallback = `${gen.root()}${rng.int(2, 99)} ${rng.pick(kinds)}`;
      usedNames.add(fallback.toLowerCase());
      return fallback;
    },

    city() {
      return rng.pick(CITIES);
    },

    address(cityEntry = gen.city()) {
      return {
        line1: `${rng.int(1, 240)}, ${rng.pick(STREETS)}`,
        city: cityEntry.city,
        state: cityEntry.state,
        postalCode: `${cityEntry.pin}${rng.digits(3)}`,
        country: 'IN',
      };
    },

    /** +91 then 0 then nine digits: well formed for the API, impossible for a real subscriber. */
    phone() {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const number = `+910${rng.digits(9)}`;
        if (!usedPhones.has(number)) {
          usedPhones.add(number);
          return number;
        }
      }
      throw new Error('could not make a unique phone number');
    },

    /** A name-based address at a reserved .example domain, unique within the run. */
    email(localHint, domain) {
      const base = slugify(localHint).replace(/-/g, '.') || 'contact';
      let candidate = `${base}@${domain}`;
      let counter = 1;
      while (usedEmails.has(candidate)) {
        counter += 1;
        candidate = `${base}.${counter}@${domain}`;
      }
      usedEmails.add(candidate);
      return candidate;
    },

    domainFor(companyName) {
      return `${slugify(companyName)}.example`;
    },

    /** Right shape, real state code, deliberately wrong check character. */
    gstin(stateCode) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const letters = Array.from({ length: 5 }, () =>
          String.fromCharCode(65 + rng.int(0, 25)),
        ).join('');
        const holder = rng.pick(['C', 'F', 'P', 'H']);
        const pan = `${letters.slice(0, 3)}${holder}${letters.slice(4)}${rng.digits(4)}${String.fromCharCode(65 + rng.int(0, 25))}`;
        const first14 = `${stateCode}${pan}${rng.int(1, 9)}Z`;
        const correct = gstinCheckCharacter(first14);
        let wrong = ALPHANUM[(ALPHANUM.indexOf(correct) + rng.int(1, 35)) % 36];
        if (wrong === correct) wrong = ALPHANUM[(ALPHANUM.indexOf(correct) + 1) % 36];
        const gstin = `${first14}${wrong}`;
        if (!usedGstins.has(gstin)) {
          usedGstins.add(gstin);
          return gstin;
        }
      }
      throw new Error('could not make a unique GSTIN');
    },
  };
  return gen;
}
