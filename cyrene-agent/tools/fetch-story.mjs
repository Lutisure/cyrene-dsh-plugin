#!/usr/bin/env node
/**
 * Fetch Honkai: Star Rail main-story chapter text from the Chinese Fandom wiki.
 *
 * Why this source. The datamine route is closed — `Dimbreath/StarRailData` returns
 * HTTP 451, removed for legal reasons, and a plain text map is `hash → string`
 * with no speaker anyway, so it cannot answer "which lines are hers". The Fandom
 * wiki transcribes quests line by line **with speaker attribution in the voice
 * filename**, which is the one thing that makes per-character extraction exact
 * rather than a guess.
 *
 * ⚠️ **`api.php` only.** The rendered HTML returns 403 to anything that is not a
 * browser; the MediaWiki API does not. That distinction cost an afternoon once.
 *
 * ⚠️ Coverage is uneven and the script says so at the end. Several Amphoreus
 * chapters are marked `{{Stub|Dialogue}}` or carry no dialogue at all, so what
 * this fetches is a floor on the real script, not the whole of it.
 *
 * Usage:
 *   node tools/fetch-story.mjs                 # fetch and cache
 *   node tools/fetch-story.mjs --force         # refetch even if cached
 *   node tools/fetch-story.mjs --category=冒险任务
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'corpus-raw', 'starrail-story');

/** Chinese wiki; the English one has the same structure but different names. */
const API = 'https://honkai-star-rail.fandom.com/zh/api.php';

/**
 * A browser-ish UA. Fandom serves the API to plain clients, but a bare Node
 * default agent gets throttled harder and occasionally 403s on redirects.
 */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'
};

/** MediaWiki caps content queries; 20 keeps the URL well inside the length limit. */
const BATCH = 20;

/** Fetch JSON with one retry, since Fandom occasionally drops a connection. */
async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((done) => setTimeout(done, 1500 * (attempt + 1)));
    }
  }
  return null;
}

/** Every page in a category, following continuation. */
async function categoryMembers(category) {
  const titles = [];
  let cont = '';
  for (let page = 0; page < 20; page += 1) {
    const url = `${API}?action=query&list=categorymembers&cmtitle=${encodeURIComponent(category)}&cmlimit=500&cmnamespace=0&format=json${cont}`;
    const json = await getJson(url);
    for (const member of json?.query?.categorymembers ?? []) titles.push(member.title);
    const next = json?.continue?.cmcontinue;
    if (next === undefined) break;
    cont = `&cmcontinue=${encodeURIComponent(next)}`;
  }
  return titles;
}

/** Wikitext for a batch of titles. */
async function wikitext(titles) {
  const url = `${API}?action=query&prop=revisions&rvslots=main&rvprop=content&format=json&titles=${encodeURIComponent(titles.join('|'))}`;
  const json = await getJson(url);
  const out = new Map();
  for (const page of Object.values(json?.query?.pages ?? {})) {
    const text = page?.revisions?.[0]?.slots?.main?.['*'];
    if (typeof text === 'string') out.set(page.title, text);
  }
  return out;
}

/** A filename that cannot escape the cache directory or confuse Windows. */
function safeName(title) {
  return `${title.replace(/[/\\:*?"<>|]/gu, '_')}.wiki`;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const categoryArg = args.find((a) => a.startsWith('--category='));
  const category = categoryArg === undefined ? 'Category:开拓任务' : `Category:${categoryArg.slice('--category='.length)}`;

  mkdirSync(CACHE, { recursive: true });
  process.stdout.write(`  category: ${category}\n`);

  const titles = await categoryMembers(category);
  process.stdout.write(`  pages:    ${titles.length}\n`);
  if (titles.length === 0) throw new Error(`no pages in ${category}`);

  const missing = force
    ? titles
    : titles.filter((title) => !existsSync(join(CACHE, safeName(title))));
  process.stdout.write(`  cached:   ${titles.length - missing.length}   fetching: ${missing.length}\n`);

  let fetched = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const pages = await wikitext(batch);
    for (const [title, text] of pages) {
      writeFileSync(join(CACHE, safeName(title)), text, 'utf8');
      fetched += 1;
    }
    process.stdout.write(`    ${Math.min(i + BATCH, missing.length)}/${missing.length}\n`);
  }

  // Coverage, reported rather than assumed: a chapter with no dialogue at all is
  // untranscribed, and one tagged Stub is partially transcribed. Both mean the
  // corpus is short of the real script, and that is worth knowing before drawing
  // conclusions from any count taken off it.
  let empty = 0;
  let stub = 0;
  for (const title of titles) {
    const file = join(CACHE, safeName(title));
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const lines = [...text.matchAll(/\{\{A\|[^}]*?\}\}\s*'''[^:']+:'''/gu)].length;
    if (lines === 0) empty += 1;
    else if (/\{\{Stub/iu.test(text)) stub += 1;
  }
  process.stdout.write(`\n  wrote ${fetched} page(s) to corpus-raw/starrail-story/\n`);
  process.stdout.write(`  ⚠️ ${empty} of ${titles.length} chapters carry no dialogue at all (untranscribed)\n`);
  process.stdout.write(`  ⚠️ ${stub} more are tagged {{Stub}} (partially transcribed)\n`);
  process.stdout.write('  Anything counted from this cache is a floor, not the script.\n');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
