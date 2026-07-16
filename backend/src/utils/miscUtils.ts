import { customAlphabet } from 'nanoid';

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const alphanumericNanoid = customAlphabet(alphabet, 16);

// custom alphabet, alphanumeric
export const getAlphanumericId = (length: number = 16): string => {
  return alphanumericNanoid(length);
};

export const shortenAddress = (address: string, startLength: number = 6, endLength: number = 4): string => {
  return address.slice(0, startLength) + '...' + address.slice(-endLength);
};

// The avatar a user actually shows: a custom upload if set, else null (the client renders the PIPS
// identicon, a colored disc with the handle's initial). Pure + dependency-free so any read path can use it.
export const effectiveAvatar = (u: { avatarUrl: string | null }): string | null => u.avatarUrl ?? null;
