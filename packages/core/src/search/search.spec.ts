import { describe, expect, it } from 'vitest';
import {
  isSearchableObjectType,
  isUsableSearchTerm,
  MAX_SEARCH_TERMS,
  SEARCHABLE_FIELDS,
  SEARCHABLE_OBJECT_TYPES,
  searchableFieldKeys,
  searchTerms,
} from './index.js';

/**
 * The tokenizer is the only place a user's query is taken apart, so it is the
 * only place an operator could survive into whatever query language a provider
 * builds. These tests are therefore as much about §5.7 as about search quality.
 */
describe('searchTerms', () => {
  it('splits on anything that is not a letter or a digit', () => {
    expect(searchTerms('John Smith')).toEqual(['john', 'smith']);
    expect(searchTerms('john.smith@acme.com')).toEqual(['john', 'smith', 'acme', 'com']);
    expect(searchTerms('+91-98765-43210')).toEqual(['91', '98765', '43210']);
  });

  it('keeps scripts other than Latin, combining marks and all', () => {
    // The vowel signs and the virama in `शर्मा` are marks, not letters. A
    // class of `\p{L}\p{N}` shreds the name into `शर` and `म`, and the person
    // becomes unfindable by their own name — in the market this product is
    // built for first (MVP_SPEC §1).
    expect(searchTerms('राज शर्मा')).toEqual(['राज', 'शर्मा']);
    expect(searchTerms('ಬೆಂಗಳೂರು')).toEqual(['ಬೆಂಗಳೂರು']);
  });

  it('leaves no query operator intact', () => {
    // Every one of these means something to to_tsquery, and nothing here may
    // reach it. The terms that come out are bare words.
    for (const hostile of [
      "john' & 'smith",
      'john | smith',
      'john:*',
      '!john',
      'john <-> smith',
      "'; drop table search_documents; --",
    ]) {
      for (const term of searchTerms(hostile)) {
        expect(term).toMatch(/^[\p{L}\p{N}\p{M}]+$/u);
      }
    }
  });

  it('drops empty pieces rather than emitting blank terms', () => {
    expect(searchTerms('   ')).toEqual([]);
    expect(searchTerms('--@--')).toEqual([]);
    expect(searchTerms('  john   ')).toEqual(['john']);
  });

  it('caps how many words one query costs', () => {
    const typed = 'a b c d e f g h i j';
    expect(searchTerms(typed)).toHaveLength(MAX_SEARCH_TERMS);
  });
});

describe('isUsableSearchTerm', () => {
  it('waits for a second character', () => {
    expect(isUsableSearchTerm('j')).toBe(false);
    expect(isUsableSearchTerm('jo')).toBe(true);
  });

  it('is happy when any one word is long enough', () => {
    expect(isUsableSearchTerm('a smith')).toBe(true);
  });

  it('is false for punctuation alone', () => {
    expect(isUsableSearchTerm('@@@')).toBe(false);
  });
});

describe('the searchable field registry', () => {
  it('covers every searchable object type', () => {
    for (const objectType of SEARCHABLE_OBJECT_TYPES) {
      expect(SEARCHABLE_FIELDS[objectType].length).toBeGreaterThan(0);
    }
  });

  it('names fields in the snake_case form field permissions use', () => {
    // A camelCase key here would silently never match a `field_permissions`
    // row, so a hidden field would stay searchable.
    for (const objectType of SEARCHABLE_OBJECT_TYPES) {
      for (const key of searchableFieldKeys(objectType)) {
        expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('does not index an activity body', () => {
    // Sanitized markup, and the likeliest place for something a colleague
    // should not stumble over (ADR-0024, ADR-0028).
    expect(searchableFieldKeys('activity')).not.toContain('body');
  });

  it('rejects an object type that is not searchable', () => {
    expect(isSearchableObjectType('invitation')).toBe(false);
    expect(isSearchableObjectType('contact')).toBe(true);
    expect(isSearchableObjectType(null)).toBe(false);
  });
});
