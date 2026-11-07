import { en } from "./en";
import { pl } from "./pl";

export type Key = keyof typeof en;
/** Every language must define every key. A missing key is a compile error. */
export type Dict = Record<Key, string>;
export type Lang = "pl" | "en";

export const LANGS: readonly Lang[] = ["pl", "en"];
export const DEFAULT_LANG: Lang = "pl";
export const dictionaries: Record<Lang, Dict> = { pl, en };

export function parseLang(v: string | null | undefined): Lang | null {
  return v === "pl" || v === "en" ? v : null;
}
