import { describe, it, expect, beforeEach } from 'vitest';
import { freshApp, signup, catId, addTx } from './helpers.js';
import { suggestCategory, matchesWord } from '../services/categorize.js';

describe('matchesWord', () => {
  it('matches whole words only, ignoring case', () => {
    expect(matchesWord('UPI/OLA CABS/8812', 'ola')).toBe(true);
    expect(matchesWord('Motorola Store', 'ola')).toBe(false);
  });

  it('treats special characters in the word literally', () => {
    expect(matchesWord('C++ Books (Amazon)', 'c++')).toBe(true);
    expect(matchesWord('C++ Books (Amazon)', 'amazon')).toBe(true);
    expect(matchesWord('50% off sale', '50%')).toBe(true);
  });
});

describe('suggestCategory', () => {
  let db, userId;
  const id = (name) => catId(db, userId, name);
  beforeEach(async () => {
    const env = freshApp();
    db = env.db;
    ({ userId } = await signup(env.app));
  });

  it('uses the starter merchant rules', () => {
    expect(suggestCategory(db, userId, { payee: 'Swiggy', type: 'expense' })).toBe(id('Food & Dining'));
  });

  it('prefers the longest matching word', () => {
    expect(suggestCategory(db, userId, { payee: 'Swiggy Instamart', type: 'expense' })).toBe(id('Groceries'));
  });

  it('falls back to the note when the payee does not match', () => {
    expect(suggestCategory(db, userId, { payee: 'Ramesh', note: 'uber to airport', type: 'expense' })).toBe(id('Transport'));
  });

  it('only suggests categories of the right kind', () => {
    expect(suggestCategory(db, userId, { payee: 'Amazon', type: 'income' })).toBeNull();
  });

  it('learns from payee history when no rule matches', () => {
    addTx(db, userId, { payee: 'Sharma Kirana', amount: 300, categoryId: id('Groceries') });
    expect(suggestCategory(db, userId, { payee: 'sharma kirana', type: 'expense' })).toBe(id('Groceries'));
  });

  it('lets rules win over history', () => {
    addTx(db, userId, { payee: 'Swiggy', amount: 300, categoryId: id('Shopping') });
    expect(suggestCategory(db, userId, { payee: 'Swiggy', type: 'expense' })).toBe(id('Food & Dining'));
  });

  it('files salary credits under Salary from the bank narration', () => {
    expect(suggestCategory(db, userId, { payee: 'Acme Corp', note: 'NEFT CR-HDFC0000001-ACME CORP-SALARY', type: 'income' })).toBe(id('Salary'));
  });

  it('returns null for transfers and unknown payees', () => {
    expect(suggestCategory(db, userId, { payee: 'Swiggy', type: 'transfer' })).toBeNull();
    expect(suggestCategory(db, userId, { payee: 'Someone new', type: 'expense' })).toBeNull();
  });
});
