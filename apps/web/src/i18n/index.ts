import { en } from './en';
import type { Messages } from './en';

/** Arabic will be registered here once the wording is supplied. Until then the English words are used. */
export const MESSAGES: Record<string, Messages> = { en };
export const t: Messages = en;
