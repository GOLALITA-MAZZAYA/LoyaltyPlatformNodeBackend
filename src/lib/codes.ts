import { randomInt } from 'node:crypto';

// No 0/o/1/l/i so codes printed on posters can't be misread.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Random public code used in join URLs, e.g. `lsl7q`. */
export function publicCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** URL-safe slug from a merchant name, e.g. "Cup & Go" -> "cup-go". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}
