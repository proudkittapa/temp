import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { thaiErrorText } from './errorText';

// Every message the Go backend can show a user must have a Thai rule in
// errorText.ts. The rules match the English text, so rewording a message
// in Go silently drops its translation - this test reads the Go source and
// fails instead. Collected: error sentinels (errors.New), fmt.Errorf
// formats that start a message ("%w: ..." or no %w at all - not wrappers
// such as "failed to ...: %w", whose sentinel is checked on its own), and
// the handlers' "error": "..." literals.

const GO_ROOT = 'golang-backend';

// Messages never shown to a user, each with the reason.
const NOT_SHOWN: Record<string, string> = {
  'promptpay: invalid character %q in ID %q': 'PROMPTPAY_ID config check at startup',
  'promptpay: %q is not a mobile number, 13-digit tax ID or 15-digit e-wallet ID': 'PROMPTPAY_ID config check at startup',
  'no price for %s at %02d:00': 'not a sentinel error: answered as "internal server error" (translated)',
  "the court's grouping changed during the booking - please try again": 'ErrCourtRegrouped is answered as "the system was busy" (translated)',
  'user not found': 'login internals; the user sees "invalid login credentials"',
  'insufficient points: balance cannot drop below zero': 'covered by the "insufficient points" rule',
};

// Sample values for formats the generic ones below don't fit.
const SAMPLES: Record<string, string> = {
  '%w: %s %s-%s is already reserved': 'slot already booked: สนามแบดมินตัน 3 18:00-19:00 is already reserved',
  '%w: %s is too long (at most %d characters)': 'invalid booking request: reason is too long (at most 500 characters)',
  '%w: %s is %s': "voucher can't be used for a free hour: FREE-1A2B is REDEEMED",
};

function goFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) goFiles(p, out);
    else if (p.endsWith('.go') && !p.endsWith('_test.go')) out.push(p);
  }
  return out;
}

const unquote = (s: string) => JSON.parse(`"${s}"`) as string;

function serverMessages(): { file: string; format: string }[] {
  const found: { file: string; format: string }[] = [];
  for (const file of goFiles(GO_ROOT)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:fmt\.Errorf|errors\.New)\("((?:[^"\\]|\\.)*)"/g)) {
      const format = unquote(m[1]);
      // A wrapper adds context to another error, whose own text is checked.
      if (format.includes('%w') && !format.startsWith('%w: ')) continue;
      found.push({ file, format });
    }
    for (const m of src.matchAll(/"error":\s*"((?:[^"\\]|\\.)*)"/g)) found.push({ file, format: unquote(m[1]) });
    for (const m of src.matchAll(/\bmsg[A-Z]\w*\s*=\s*"((?:[^"\\]|\\.)*)"/g)) found.push({ file, format: unquote(m[1]) });
  }
  return found;
}

function sample(format: string): string {
  if (SAMPLES[format]) return SAMPLES[format];
  return format
    .replace(/^%w: /, 'invalid booking request: ')
    .replace(/%\.2f/g, '180.00')
    .replace(/%0?\d*d/g, '12')
    .replace(/%q/g, '"X1"')
    .replace(/%[sv]/g, 'X1'); // ids, codes and statuses are plain words
}

describe('server messages', () => {
  const messages = serverMessages();

  it('finds the backend source', () => {
    expect(messages.length).toBeGreaterThan(150);
  });

  it('every message a user can see has a Thai translation', () => {
    const missing = messages
      .filter(({ format }) => !(format in NOT_SHOWN))
      .filter(({ format }) => {
        const s = sample(format);
        return thaiErrorText(s) === s;
      })
      .map(({ file, format }) => `${file.slice(GO_ROOT.length + 1)}: ${format}`);
    expect(missing).toEqual([]);
  });

  it('lists no message that is gone from the backend', () => {
    const formats = new Set(messages.map(m => m.format));
    expect(Object.keys(NOT_SHOWN).filter(f => !formats.has(f))).toEqual([]);
    expect(Object.keys(SAMPLES).filter(f => !formats.has(f))).toEqual([]);
  });
});
