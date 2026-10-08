import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  readSheet, detectHeaderRow, guessMapping, detectDateFormat, parseDate, parseAmount,
  payeeFromNarration, buildPreview, headerSignature,
} from '../services/statement.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

describe('readSheet', () => {
  it('reads a CSV as text, keeping day-first dates untouched', () => {
    const rows = readSheet(b64('Date,Narration,Withdrawal Amt.\n05/10/26,Chai ₹ stall,"1,250.00"\n\n'), 'hdfc.csv');
    expect(rows).toEqual([['Date', 'Narration', 'Withdrawal Amt.'], ['05/10/26', 'Chai ₹ stall', '1,250.00']]);
  });

  it('reads the first sheet of an .xlsx, turning date cells into YYYY-MM-DD', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Txn Date', 'Description', 'Debit'], ['x', 'Chai', 20]]);
    ws.A2 = { t: 'n', v: 46300, z: 'dd/mm/yyyy' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Statement');
    const rows = readSheet(XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }), 'sbi.xlsx');
    expect(rows).toEqual([['Txn Date', 'Description', 'Debit'], ['2026-10-05', 'Chai', '20']]);
  });
});

describe('detectHeaderRow', () => {
  it('skips bank details above the headings', () => {
    const rows = [
      ['HDFC BANK Ltd.'], ['Account No: 1234'], ['Statement From 01/09/2026 To 30/09/2026'], [''], ['Nomination: Registered'],
      ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
      ['05/09/26', 'UPI/SWIGGY', '123', '05/09/26', '250', '', '9750'],
    ];
    expect(detectHeaderRow(rows)).toBe(5);
  });

  it('returns -1 when no headings are found', () => {
    expect(detectHeaderRow([['hello'], ['world']])).toBe(-1);
  });
});

describe('guessMapping', () => {
  it('reads HDFC-style split columns', () => {
    expect(guessMapping(['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'])).toEqual({
      layout: 'split', date: 0, description: 1, debit: 4, credit: 5, amount: null, drcr: null, balance: 6,
    });
  });

  it('reads SBI-style columns, ignoring Value Date', () => {
    expect(guessMapping(['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'])).toEqual({
      layout: 'split', date: 0, description: 2, debit: 4, credit: 5, amount: null, drcr: null, balance: 6,
    });
  });

  it('reads a single amount column with a Cr/Dr column', () => {
    expect(guessMapping(['Transaction Date', 'Particulars', 'Amount', 'Cr/Dr', 'Balance'])).toEqual({
      layout: 'single', date: 0, description: 1, debit: null, credit: null, amount: 2, drcr: 3, balance: 4,
    });
  });
});

describe('dates', () => {
  it('defaults to day-first and detects month-first or year-first only when the data proves it', () => {
    expect(detectDateFormat(['05/10/26', '06/10/26'])).toBe('dmy');
    expect(detectDateFormat(['10/05/2026', '10/25/2026'])).toBe('mdy');
    expect(detectDateFormat(['25/10/2026', '10/05/2026'])).toBe('dmy');
    expect(detectDateFormat(['2026-10-05'])).toBe('ymd');
  });

  it('parses every supported style', () => {
    for (const text of ['05/10/2026', '05-10-2026', '05.10.2026', '05/10/26', '05-Oct-2026', '05 Oct 26', '5 Sept 2026', '2026-10-05', '05/10/2026 13:45']) {
      expect(parseDate(text, 'dmy'), text).toBe(text === '5 Sept 2026' ? '2026-09-05' : '2026-10-05');
    }
    expect(parseDate('10/05/2026', 'mdy')).toBe('2026-10-05');
  });

  it('rejects things that are not dates', () => {
    for (const text of ['', 'Opening Balance', '31/02/2026', '13/13/2026', 'Total']) expect(parseDate(text, 'dmy')).toBeNull();
  });
});

describe('parseAmount', () => {
  it('handles rupee symbols, commas, brackets, signs and Dr/Cr', () => {
    expect(parseAmount('₹1,234.50')).toBe(1234.5);
    expect(parseAmount('Rs. 500')).toBe(500);
    expect(parseAmount('INR 2,00,000')).toBe(200000);
    expect(parseAmount('(1,234.00)')).toBe(-1234);
    expect(parseAmount('-75')).toBe(-75);
    expect(parseAmount('500 Dr')).toBe(-500);
    expect(parseAmount('500.00 Cr')).toBe(500);
    expect(parseAmount('0.00')).toBe(0);
  });

  it('returns null for blanks and text', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount('N/A')).toBeNull();
  });
});

describe('payeeFromNarration', () => {
  it('pulls the merchant out of bank narrations', () => {
    expect(payeeFromNarration('UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment')).toBe('Swiggy');
    expect(payeeFromNarration('UPI-ZOMATO LTD-ZOMATO@HDFCBANK-HDFC0000499-412345678901-PAYMENT')).toBe('Zomato Ltd');
    expect(payeeFromNarration('NEFT CR-HDFC0000001-ACME TECHNOLOGIES PVT LTD-SALARY OCT')).toBe('Acme Technologies Pvt Ltd');
    expect(payeeFromNarration('POS 416021XXXXXX1234 AMAZON PAY INDIA')).toBe('Amazon Pay India');
    expect(payeeFromNarration('ATM WDL/MG ROAD BANGALORE')).toBe('ATM withdrawal');
  });

  it('leaves ordinary text alone and falls back to the UPI name', () => {
    expect(payeeFromNarration('Chai at office')).toBe('Chai at office');
    expect(payeeFromNarration('UPI/412345678901/rahul.k@okaxis')).toBe('rahul.k');
  });
});

describe('buildPreview', () => {
  const split = { layout: 'split', date: 0, description: 1, debit: 2, credit: 3, amount: null, drcr: null, balance: 4 };

  it('turns rows into money in/out and lists rows it skipped', () => {
    const rows = [
      ['Date', 'Narration', 'Withdrawal', 'Deposit', 'Balance'],
      ['', 'Opening Balance', '', '', '10,000.00'],
      ['05/10/26', 'UPI/DR/1/SWIGGY/YESB/s@ybl', '250.00', '', '9,750.00'],
      ['06/10/26', 'NEFT CR-HDFC0000001-ACME CORP-SALARY', '0.00', '50,000.00', '59,750.00'],
      ['07/10/26', 'Charges reversed', '', '', '59,750.00'],
      ['', 'Total', '250.00', '50,000.00', ''],
    ];
    const preview = buildPreview(rows, 0, split, 'dmy');
    expect(preview.transactions).toEqual([
      { row: 2, occurredAt: '2026-10-05', amount: 250, direction: 'out', note: 'UPI/DR/1/SWIGGY/YESB/s@ybl', payee: 'Swiggy' },
      { row: 3, occurredAt: '2026-10-06', amount: 50000, direction: 'in', note: 'NEFT CR-HDFC0000001-ACME CORP-SALARY', payee: 'Acme Corp' },
    ]);
    expect(preview.skipped.map((s) => [s.row, s.reason])).toEqual([[1, 'No valid date'], [4, 'No amount'], [5, 'No valid date']]);
    expect(preview.statementClosing).toBe(59750);
  });

  it('uses a Dr/Cr column in single-amount files and finds the closing balance in newest-first files', () => {
    const single = { layout: 'single', date: 0, description: 1, debit: null, credit: null, amount: 2, drcr: 3, balance: 4 };
    const rows = [
      ['Transaction Date', 'Particulars', 'Amount', 'Cr/Dr', 'Balance'],
      ['06-Oct-2026', 'Salary', '50,000.00', 'CR', '60,000.00'],
      ['06-Oct-2026', 'Rent', '15,000.00', 'DR', '45,000.00'],
      ['05-Oct-2026', 'Chai', '20.00', 'DR', '10,000.00'],
    ];
    const preview = buildPreview(rows, 0, single, 'dmy');
    expect(preview.transactions.map((t) => [t.direction, t.amount])).toEqual([['in', 50000], ['out', 15000], ['out', 20]]);
    expect(preview.statementClosing).toBe(60000);
  });
});

describe('headerSignature', () => {
  it('normalises heading text', () => {
    expect(headerSignature([' Txn  Date', 'DEBIT', '', 'Balance '])).toBe('txn date|debit|balance');
  });
});
