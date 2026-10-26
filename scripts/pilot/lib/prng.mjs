/**
 * A small seeded random number generator, so a re-run produces the same data.
 *
 * mulberry32 is enough here: this is test data, never anything secret. Every stream is made from a
 * text label ("wholesale/accounts"), so adding a new stream does not change what the others produce.
 */

/** FNV-1a, 32 bit: turns a label into a number. */
export function hashString(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function makeRng(label) {
  let state = hashString(label) || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng = {
    /** A number in [0, 1). */
    next,
    /** A whole number from `low` to `high`, both included. */
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    /** True with the given chance (0 to 1). */
    chance: (probability) => next() < probability,
    pick: (list) => list[Math.floor(next() * list.length)],
    /** `entries` is [[value, weight], ...]. */
    weighted: (entries) => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let point = next() * total;
      for (const [value, weight] of entries) {
        point -= weight;
        if (point < 0) return value;
      }
      return entries[entries.length - 1][0];
    },
    shuffle: (list) => {
      const copy = [...list];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        [copy[index], copy[other]] = [copy[other], copy[index]];
      }
      return copy;
    },
    /** Digits as a string, so leading zeros survive. */
    digits: (count) => Array.from({ length: count }, () => String(rng.int(0, 9))).join(''),
    /** A new stream that depends on this label only. */
    fork: (suffix) => makeRng(`${label}/${suffix}`),
  };
  return rng;
}
