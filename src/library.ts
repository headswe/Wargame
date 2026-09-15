import { type LevelData, migrate } from './sim/world/level-data.ts';

/**
 * The levels somebody made, kept where the game can find them.
 *
 * The editor already had an autosave slot, but an autosave answers a different
 * question: it is "what was I in the middle of", and there is only ever one of
 * it. This is the shelf you put a level on when you are done with it, which is
 * what makes the editor part of the game rather than a tool that happens to
 * share a build — a level you cannot pick from the contract list is a level
 * nobody plays.
 *
 * It is browser storage, so it lives outside `src/sim/` (which runs under Node
 * for the tests and must not know what a `localStorage` is) and outside both
 * `ui/` and `editor/`, since each end would otherwise be importing the other.
 */

const KEY = 'wargame.levels';

export interface SavedLevel {
  id: string;
  name: string;
  /** Last written. The shelf reads newest first, which is where you just looked. */
  savedAt: number;
  data: LevelData;
}

/** Ids the shipped contracts already answer to, which an author must not shadow. */
export const RESERVED = new Set(['stepove', 'kolna']);

export function savedLevels(): SavedLevel[] {
  const out: SavedLevel[] = [];
  for (const row of read()) {
    try {
      // Migrating on the way out rather than on the way in means a level saved
      // by an older build still opens after the format moves on.
      out.push({ ...row, data: migrate(row.data) });
    } catch (error) {
      // A level written by a *newer* build cannot be read by this one. Dropping
      // it from the list is right — offering a contract that will not build is
      // worse — but it must say so, because from the author's side the level
      // has simply vanished.
      console.warn(`skipping saved level "${row.id}":`, error);
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function savedLevel(id: string): SavedLevel | null {
  return savedLevels().find((l) => l.id === id) ?? null;
}

/** True if this id is already taken by something that is not this level. */
export function idTaken(id: string): boolean {
  return RESERVED.has(id) || read().some((l) => l.id === id);
}

/**
 * Put a level on the shelf, replacing any earlier one with the same id.
 *
 * Replacing rather than appending is deliberate: publishing the same level
 * twice is a revision, not a second contract. Two genuinely different levels
 * need two different ids, which is the editor's problem to ask about.
 */
export function saveLevel(data: LevelData): SavedLevel {
  const entry: SavedLevel = {
    id: data.id, name: data.name, savedAt: Date.now(), data,
  };
  const all = read().filter((l) => l.id !== entry.id);
  all.push(entry);
  write(all);
  return entry;
}

export function forgetLevel(id: string): void {
  write(read().filter((l) => l.id !== id));
}

/** A level id from a name: lowercase, words joined by dashes, nothing exotic. */
export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'level';
}

// --------------------------------------------------------------------- disk

function read(): SavedLevel[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedLevel[]).filter(sane) : [];
  } catch (error) {
    // A corrupt shelf must not take the menu down with it: an author who cannot
    // reach the picker cannot reach the editor to fix anything either.
    console.warn('could not read the level library:', error);
    return [];
  }
}

function sane(row: unknown): row is SavedLevel {
  const l = row as SavedLevel;
  return !!l && typeof l.id === 'string' && typeof l.name === 'string' && !!l.data;
}

function write(all: SavedLevel[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch (error) {
    // Out of quota, or storage denied outright. The caller has to hear about
    // this — a save button that silently does nothing is how work is lost.
    throw new Error(
      `could not save the level: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
