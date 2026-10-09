import { randomInt } from 'node:crypto';

// No look-alike characters (0/o, 1/l/i), so IDs survive being read aloud or retyped.
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function randomId(length: number): string {
  let id = '';
  for (let i = 0; i < length; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

/** Appears in the public application URL. */
export const newJobId = () => randomId(10);
export const newApplicationId = () => `APP-${randomId(10).toUpperCase()}`;
export const newQuestionId = () => `q_${randomId(8)}`;

export const isJobId = (value: string) => /^[a-z0-9]{6,20}$/.test(value);
export const isApplicationId = (value: string) => /^APP-[A-Z0-9]{6,20}$/.test(value);
