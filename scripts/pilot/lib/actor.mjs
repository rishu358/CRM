import { Api } from './http.mjs';

/**
 * One member of staff during the simulation: a signed-in API client, a private random stream, and the
 * list of records they currently know about (what is on their screen). The book is refreshed from the
 * API each Monday, the way a person reloads a list, and kept up to date from the responses they get.
 */

const TYPES = ['account', 'contact', 'lead', 'deal', 'activity'];
const PATHS = {
  account: '/accounts',
  contact: '/contacts',
  lead: '/leads',
  deal: '/deals',
  activity: '/activities',
};

export class Actor {
  constructor({ business, member, record, rng, metrics, baseUrl }) {
    this.business = business;
    this.member = member;
    this.record = record;
    this.rng = rng;
    this.name = member.name;
    this.key = member.key;
    this.role = member.role;
    this.api = new Api({ baseUrl, metrics, who: `${business.id}/${member.name}` });
    this.book = Object.fromEntries(TYPES.map((type) => [type, new Map()]));
    this.counts = {};
  }

  get isOwner() {
    return this.key === 'owner';
  }
  get isManager() {
    return this.key === 'manager';
  }
  get isReadOnly() {
    return this.role === 'Read-only';
  }
  get isSeller() {
    return !this.isOwner && !this.isReadOnly;
  }

  count(name, by = 1) {
    this.counts[name] = (this.counts[name] ?? 0) + by;
  }

  async signIn(password) {
    return this.api.signIn(this.record.email, password, { totpSecret: this.record.totpSecret });
  }

  get userId() {
    return this.api.userId;
  }

  /** Remember (or update) a record from an API response. */
  track(type, data, extra = {}) {
    if (!data?.id) return;
    const previous = this.book[type].get(data.id) ?? {};
    const fresh = Object.fromEntries(
      Object.entries(slim(type, data)).filter(([, value]) => value !== undefined),
    );
    this.book[type].set(data.id, { ...previous, ...fresh, ...extra });
  }

  forget(type, id) {
    this.book[type].delete(id);
  }

  list(type) {
    return [...this.book[type].values()];
  }

  pick(type, predicate = () => true) {
    const pool = this.list(type).filter(predicate);
    return pool.length === 0 ? null : this.rng.pick(pool);
  }

  /** Reload every list from the API and return the raw rows, for scope checks. */
  async refresh() {
    const raw = {};
    for (const type of TYPES) {
      const result = await this.api.listAll(`${type}.list-all`, PATHS[type]);
      raw[type] = result.rows;
      if (!result.ok) {
        raw[`${type}Error`] = result.last;
        continue;
      }
      this.book[type].clear();
      for (const row of result.rows) this.track(type, row);
    }
    return raw;
  }
}

function slim(type, data) {
  const base = { id: data.id, version: data.version, ownerId: data.ownerId };
  switch (type) {
    case 'account':
      return {
        ...base,
        name: data.name,
        email: data.email,
        phone: data.phone,
        createdAt: data.createdAt,
      };
    case 'contact':
      return {
        ...base,
        name: `${data.firstName ?? ''} ${data.lastName ?? ''}`.trim(),
        lastName: data.lastName,
        accountId: data.accountId,
        email: data.email,
        phone: data.phone,
        createdAt: data.createdAt,
      };
    case 'lead':
      return {
        ...base,
        name: `${data.firstName ?? ''} ${data.lastName ?? ''}`.trim(),
        company: data.company,
        status: data.status,
        email: data.email,
        phone: data.phone,
        createdAt: data.createdAt,
      };
    case 'deal':
      return {
        ...base,
        name: data.name,
        accountId: data.accountId,
        stageId: data.stageId,
        amount: data.amount,
        closedAt: data.closedAt,
        probability: data.probability,
        primaryContactId: data.primaryContactId,
      };
    case 'activity':
      return {
        id: data.id,
        version: data.version,
        subject: data.subject,
        type: data.type,
        status: data.status,
        dueAt: data.dueAt,
        assignedTo: data.assignedTo,
        links: data.links,
      };
    default:
      return base;
  }
}

export { PATHS, TYPES };
