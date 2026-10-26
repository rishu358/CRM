import { fieldKey, optionValue, optionValues } from './context.mjs';

/**
 * Builds API payloads (what the web app would send) for each kind of record, for one business.
 * Everything random comes from the stream it is given, so a re-run reproduces the same payloads.
 */

const TRANSPORTS = ['Own tempo', 'VRL parcel', 'Local transporter', 'Customer pickup', 'Courier'];
const TITLES = [
  'Owner',
  'Manager',
  'Purchase head',
  'Accounts',
  'Proprietor',
  'Partner',
  'Admin officer',
];

export const rupees = (amount) => ({
  amountMinor: String(Math.round(amount * 100)),
  currency: 'INR',
});

/** A custom currency field is stored differently from money elsewhere in the API (a finding). */
const customRupees = (amount) => ({
  amount_minor: String(Math.round(amount * 100)),
  currency: 'INR',
});

const logUniform = (rng, low, high) =>
  Math.exp(Math.log(low) + rng.next() * (Math.log(high) - Math.log(low)));

/** Round to something a person would quote: nearest 500 for big sums, 50 for small. */
export function roundQuote(amount) {
  const step = amount >= 20000 ? 500 : amount >= 2000 ? 100 : 50;
  return Math.max(step, Math.round(amount / step) * step);
}

export function makeBuilders({ business, rng, gen, context }) {
  const key = (objectType, label) => fieldKey(context, objectType, label);
  const pickOption = (objectType, label) => rng.pick(optionValues(context, objectType, label));
  const isCoaching = business.id === 'coaching';

  const builders = {
    /** @param {{ omit?: Set<string>, kind?: 'school'|'family' }} [options] */
    account({ omit = new Set(), kind } = {}) {
      const place = gen.city();
      let name;
      let accountKind = kind;
      if (isCoaching) {
        accountKind ??= rng.chance(0.3) ? 'school' : 'family';
        name =
          accountKind === 'school'
            ? gen.companyName(business.schoolKinds)
            : `${gen.person().lastName} Family ${rng.int(1, 99)}`;
      } else {
        name = gen.companyName(business.customerKinds);
      }
      const payload = {
        name,
        phone: gen.phone(),
        email: gen.email(`info ${name}`, gen.domainFor(name)),
        billingAddress: gen.address(place),
        customFields: {},
      };
      if (!isCoaching || accountKind === 'school') payload.domain = gen.domainFor(name);
      if (!isCoaching) payload.gstin = rng.chance(0.85) ? gen.gstin(place.gst) : null;
      if (!isCoaching && rng.chance(0.5)) payload.employeeCount = rng.int(2, 60);
      if (!omit.has('annualRevenue') && !isCoaching && rng.chance(0.5)) {
        payload.annualRevenue = rupees(roundQuote(logUniform(rng, 500000, 50000000)));
      }
      const custom = payload.customFields;
      if (business.id === 'wholesale') {
        custom[key('account', 'Customer type')] = pickOption('account', 'Customer type');
        custom[key('account', 'Credit days')] = rng.pick([0, 7, 15, 21, 30, 45]);
        if (!omit.has('Credit limit'))
          custom[key('account', 'Credit limit')] = customRupees(
            roundQuote(logUniform(rng, 20000, 800000)),
          );
        if (rng.chance(0.6)) custom[key('account', 'Preferred transport')] = rng.pick(TRANSPORTS);
      } else if (business.id === 'repairs') {
        const status = pickOption('account', 'AMC status');
        custom[key('account', 'AMC status')] = status;
        if (rng.chance(0.6)) custom[key('account', 'Number of sites')] = rng.int(1, 6);
      } else if (isCoaching) {
        custom[key('account', 'Account kind')] = optionValue(
          context,
          'account',
          'Account kind',
          accountKind === 'school' ? 'School tie-up' : 'Family',
        );
      }
      return { payload, place, accountKind };
    },

    contact({ accountId = null, accountName = null, lastName } = {}) {
      const person = gen.person();
      const last = lastName ?? person.lastName;
      const domain = accountName
        ? gen.domainFor(accountName)
        : business.domain.replace(/^[^.]+/, 'people');
      const payload = {
        firstName: person.firstName,
        lastName: last,
        email: gen.email(`${person.firstName} ${last}`, domain),
        phone: gen.phone(),
        title: isCoaching ? null : rng.pick(TITLES),
        accountId,
        leadSource: rng.weighted(business.leadSources),
        customFields: {},
      };
      if (rng.chance(0.7)) payload.whatsapp = payload.phone;
      if (business.id === 'wholesale' && rng.chance(0.6))
        payload.customFields[key('contact', 'Orders by WhatsApp')] = rng.chance(0.7);
      if (business.id === 'repairs' && rng.chance(0.5))
        payload.customFields[key('contact', 'Site contact')] = true;
      if (isCoaching) {
        payload.customFields[key('contact', 'Relation')] = optionValue(
          context,
          'contact',
          'Relation',
          rng.weighted([
            ['Parent', 6],
            ['Student', 3],
            ['School coordinator', 1],
          ]),
        );
        payload.customFields[key('contact', 'Student class')] = pickOption(
          'contact',
          'Student class',
        );
      }
      return { payload, person };
    },

    lead() {
      const person = gen.person();
      const isCompany = !isCoaching;
      const company = isCompany ? gen.companyName(business.customerKinds) : null;
      const payload = {
        firstName: person.firstName,
        lastName: person.lastName,
        company,
        email: gen.email(
          `${person.firstName} ${person.lastName}`,
          company ? gen.domainFor(company) : business.domain.replace(/^[^.]+/, 'people'),
        ),
        phone: gen.phone(),
        source: rng.weighted(business.leadSources),
        status: rng.weighted([
          ['new', 5],
          ['contacted', 3],
          ['qualified', 2],
          ['unqualified', 1],
        ]),
        customFields: {},
      };
      const custom = payload.customFields;
      if (business.id === 'wholesale' && rng.chance(0.6))
        custom[key('lead', 'Expected monthly purchase')] = customRupees(
          roundQuote(logUniform(rng, 10000, 300000)),
        );
      if (business.id === 'repairs')
        custom[key('lead', 'Device type')] = pickOption('lead', 'Device type');
      if (isCoaching) {
        custom[key('lead', 'Student class')] = pickOption('lead', 'Student class');
        custom[key('lead', 'Target exam')] = pickOption('lead', 'Target exam');
        custom[key('lead', 'Preferred batch')] = pickOption('lead', 'Preferred batch');
        if (rng.chance(0.7))
          custom[key('lead', 'School name')] = `${gen.root()} ${rng.pick(business.schoolKinds)}`;
      }
      return { payload, person };
    },

    /** A deal payload. `today` is a YYYY-MM-DD date in simulated time. */
    deal({ accountId, accountName, contactId = null, stageId, today }) {
      const product = rng.pick(business.products);
      const [low, high] = business.amountRupees;
      let amount = roundQuote(logUniform(rng, low, high));
      if (business.id === 'repairs' && /AMC/.test(product))
        amount = roundQuote(logUniform(rng, 8000, 120000));
      if (business.id === 'repairs' && !/AMC/.test(product))
        amount = roundQuote(logUniform(rng, 1500, 30000));
      const closeInDays = rng.int(3, 60);
      const payload = {
        name: rng.pick(business.dealNames)(product, accountName),
        accountId,
        primaryContactId: contactId,
        stageId,
        amount: rupees(amount),
        expectedCloseDate: addDays(today, closeInDays),
        customFields: {},
      };
      const custom = payload.customFields;
      if (business.id === 'wholesale') {
        custom[key('deal', 'Product category')] = pickOption('deal', 'Product category');
        custom[key('deal', 'Payment terms')] = pickOption('deal', 'Payment terms');
      } else if (business.id === 'repairs') {
        custom[key('deal', 'Service type')] = optionValue(
          context,
          'deal',
          'Service type',
          /AMC/.test(product) ? 'AMC' : rng.pick(['Repair', 'Installation', 'Spares']),
        );
        custom[key('deal', 'Device type')] = pickOption('deal', 'Device type');
        custom[key('deal', 'Urgency')] = pickOption('deal', 'Urgency');
      } else if (isCoaching) {
        custom[key('deal', 'Course')] = optionValue(context, 'deal', 'Course', product);
        custom[key('deal', 'Batch start')] = addDays(today, rng.int(10, 90));
        custom[key('deal', 'Scholarship percent')] = rng.pick([0, 0, 10, 20, 25, 50]);
        custom[key('deal', 'Fee instalments')] = rng.pick([1, 2, 3, 4]);
      }
      return { payload, product, amount };
    },

    /** A task, call or meeting. `links` are [{objectType, recordId}]. */
    activity({ type = 'task', subjectVars, links, dueAt, assignedTo, priority }) {
      const subject = fill(rng.pick(business.taskSubjects), subjectVars);
      return {
        type,
        subject: type === 'call' ? `Call: ${subject}` : subject,
        dueAt,
        priority:
          priority ??
          rng.weighted([
            ['low', 2],
            ['normal', 6],
            ['high', 2],
          ]),
        assignedTo,
        links,
        reminderMinutesBefore: rng.chance(0.4) ? rng.pick([15, 60, 1440]) : undefined,
      };
    },

    note({ vars, links }) {
      const text = fill(rng.pick(business.noteTexts), vars);
      return { type: 'note', subject: text.slice(0, 80), body: text, links };
    },
  };
  return builders;
}

export function fill(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (_match, name) => vars[name] ?? name);
}

export function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
