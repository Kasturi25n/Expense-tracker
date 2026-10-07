import { describe, it, expect } from 'vitest';
import { addPeriod, addDays, occurrencesBetween } from '../services/recurring.js';

describe('addPeriod', () => {
  it('keeps the 31st sticky across short months', () => {
    expect(addPeriod('2026-01-31', 'monthly', 31)).toBe('2026-02-28');
    expect(addPeriod('2026-02-28', 'monthly', 31)).toBe('2026-03-31');
  });

  it('handles leap years for yearly items', () => {
    expect(addPeriod('2028-02-29', 'yearly', 29)).toBe('2029-02-28');
    expect(addPeriod('2031-02-28', 'yearly', 29)).toBe('2032-02-29');
  });

  it('adds three months for quarterly, crossing the year', () => {
    expect(addPeriod('2026-11-30', 'quarterly', 30)).toBe('2027-02-28');
  });

  it('adds seven days for weekly, crossing the month', () => {
    expect(addPeriod('2026-09-28', 'weekly', 28)).toBe('2026-10-05');
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-12-30', 7)).toBe('2027-01-06');
  });
});

describe('occurrencesBetween', () => {
  const rule = { next_date: '2026-07-05', frequency: 'monthly', anchor_day: 5, end_date: null };

  it('lists every due date up to and including the limit', () => {
    expect(occurrencesBetween(rule, '2026-10-05')).toEqual({
      dates: ['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05'],
      nextDate: '2026-11-05',
    });
  });

  it('stops at the end date', () => {
    expect(occurrencesBetween({ ...rule, end_date: '2026-08-31' }, '2026-10-07')).toEqual({
      dates: ['2026-07-05', '2026-08-05'],
      nextDate: '2026-09-05',
    });
  });

  it('returns nothing when not yet due', () => {
    expect(occurrencesBetween({ ...rule, next_date: '2026-10-10' }, '2026-10-07')).toEqual({ dates: [], nextDate: '2026-10-10' });
  });
});
