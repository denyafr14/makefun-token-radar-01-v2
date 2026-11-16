// Token Launch Radar — a make.fun token-radar-01 entry (Node 22, standard library only).
//
// The program reads the sealed DefiLlama snapshot at /input/snapshot.json, values every protocol that
// records no token yet, and writes the ranked board to /output/board.json. It copies this repository's
// dashboard/ and screenshots/ to /output, generates the dashboard's data file (zdata.js) into
// /output/dashboard/, and writes /output/dossier.json with the vendored make.fun library.
//
// The value model (peer-multiple-1). A pre-token protocol is worth what its own category's tokened
// protocols say a dollar of TVL is worth, adjusted for its momentum and for how long it has run
// with no token:
//
//   M_c     the median market-cap/TVL multiple of category c, over the snapshot protocols in c whose
//           market cap and TVL are both present and positive, clamped to [0.10, 10.0]; a category
//           with no such peer falls back to the snapshot-wide median (same clamp), else 1.0
//   G       clamp(1 + change_7d / 100, 0.75, 1.35); an unreported change_7d scores G = 1
//   Y       clamp(1 + 0.08 x sqrt(years), 1.00, 1.40), years being the time since listed_at against
//           the snapshot's latest listed_at, in 365.25-day years; an unlisted date scores Y = 1
//   implied max(1, round(tvl_usd x M_c x G x Y))
//
// The board is every pre-token protocol (no gecko id, no symbol, no market cap), ranked by implied
// value, ties broken by slug. Protocols whose token already trades are never board rows: they are the
// peer basis the multiples come from, and the dashboard's detail view shows that basis for each row.
// No protocol name is special-cased anywhere: one function scores every row, and the farm plan of a
// row is generated from its own category family, chains and TVL tier. The run is deterministic: no
// clocks, no randomness, every sort carries an explicit tiebreak, so two runs write identical bytes.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps, as the starter states them: the text cap shapes the dossier's bytes. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The model's version label, named in the dashboard's data and its methodology line. */
const MODEL_VERSION = 'peer-multiple-1';

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

// ---------------------------------------------------------------- the snapshot

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new Error('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new Error('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new Error('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new Error('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new Error('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new Error(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---------------------------------------------------------------- the model

const DAY_MS = 86_400_000;
const MULTIPLE_MIN = 0.1;
const MULTIPLE_MAX = 10.0;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The median of a non-empty list: the middle value, or the mean of the two middle ones. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One category's peer basis: how many tokened peers carry a usable multiple, and the multiple itself. */
interface PeerBasis {
  peers: number;
  median: number | null;
  applied: number;
}

/**
 * The peer basis of every category in the snapshot, plus the fallback. A peer is any protocol whose
 * market cap and TVL are both present and positive; its multiple is mcap_usd / tvl_usd.
 */
function peerBases(snapshot: Snapshot): { byCategory: Map<string | null, PeerBasis>; fallback: number; peerCount: number } {
  const ratios = new Map<string | null, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    const list = ratios.get(p.category);
    if (list === undefined) ratios.set(p.category, [ratio]);
    else list.push(ratio);
    all.push(ratio);
  }
  const fallback = all.length > 0 ? clamp(median(all), MULTIPLE_MIN, MULTIPLE_MAX) : 1.0;
  const byCategory = new Map<string | null, PeerBasis>();
  for (const [category, list] of ratios) {
    const med = median(list);
    byCategory.set(category, { peers: list.length, median: med, applied: clamp(med, MULTIPLE_MIN, MULTIPLE_MAX) });
  }
  return { byCategory, fallback, peerCount: all.length };
}

/** Whether a protocol records no token at all: the board's membership rule. */
function isTokenless(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null && p.mcap_usd === null;
}

/** A protocol's three factors and its implied value under the model. */
interface Scored {
  multiple: number;
  growth: number;
  years: number | null;
  yearsFactor: number;
  implied: number;
}

function score(p: SnapshotProtocol, basis: PeerBasis | undefined, fallback: number, latestListedMs: number): Scored {
  const multiple = basis === undefined ? fallback : basis.applied;
  const growth = p.change_7d === null ? 1 : clamp(1 + p.change_7d / 100, 0.75, 1.35);
  let years: number | null = null;
  let yearsFactor = 1;
  if (p.listed_at !== null) {
    const listedMs = Date.parse(`${p.listed_at}T00:00:00Z`);
    if (Number.isFinite(listedMs)) {
      years = Math.max(0, (latestListedMs - listedMs) / DAY_MS / 365.25);
      yearsFactor = clamp(1 + 0.08 * Math.sqrt(years), 1.0, 1.4);
    }
  }
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growth * yearsFactor));
  return { multiple, growth, years, yearsFactor, implied };
}

// ---------------------------------------------------------------- farm plans

/** Whole dollars with thousands separators, written out by hand so no locale is consulted. */
function money(n: number): string {
  const digits = String(n);
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return `$${out}`;
}

/** The capital range and holding window a protocol's TVL tier assigns to its farm plan. */
function tierOf(tvl: number): { lo: number; hi: number; hold: string } {
  if (tvl < 75_000_000) return { lo: 250, hi: 1_000, hold: '6-10' };
  if (tvl <= 250_000_000) return { lo: 1_000, hi: 5_000, hold: '8-12' };
  return { lo: 5_000, hi: 25_000, hold: '10-16' };
}

type Family = 'lending' | 'dex' | 'perps' | 'yield' | 'staking' | 'restaking' | 'bridge' | 'cdp' | 'generic';

/** The farm family a category belongs to; anything unlisted, and no category, is the generic family. */
function familyOf(category: string | null): Family {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lending')) return 'lending';
  if (c === 'dexs') return 'dex';
  if (c === 'derivatives' || c === 'options' || c.includes('derivative')) return 'perps';
  if (c === 'liquid restaking' || c === 'restaking' || c === 'restaked btc') return 'restaking';
  if (c === 'liquid staking' || c === 'staking pool') return 'staking';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('cdp') || c.includes('stablecoin') || c === 'algo-stables') return 'cdp';
  if (c === 'yield' || c === 'yield aggregator' || c === 'leveraged farming' || c === 'farm') return 'yield';
  return 'generic';
}

/**
 * A protocol's farm plan: exactly four steps from its category family's templates, parameterised by
 * its own name, primary chain, chain count and TVL tier. Every step names a concrete action, a dollar
 * amount or range, and a duration in weeks.
 */
function farmSteps(p: SnapshotProtocol): string[] {
  const name = p.name;
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its primary chain';
  const { lo, hi, hold } = tierOf(p.tvl_usd);
  const range = `${money(lo)}-${money(hi)}`;
  const small = money(lo);
  const family = familyOf(p.category);
  let steps: string[];
  if (family === 'lending') {
    steps = [
      `Supply ${range} of USDC on ${name} via ${chain} and hold the position ${hold} weeks, adding on dips rather than in one lump; the steady supplied balance is the activity record a future distribution would measure.`,
      `Borrow about ${small} against that collateral on ${name}, keep the loan 2-3 weeks, then repay in full and repeat once; finished borrow-and-repay cycles show genuine credit use, not a parked deposit.`,
      `Rebalance the ${name} position once a month, claim any rewards the moment they are offered, and vote in its governance on ${chain} when a poll opens; keep every action in one wallet so the record stays attributable.`,
      `Check the points or rewards page of ${name} every week from week 4 on, and hold the supplied balance until a snapshot or season end is announced; unwind over 1-2 weeks once any claim window opens.`,
    ];
  } else if (family === 'dex') {
    steps = [
      `Provide ${range} of liquidity to the main USDC-ETH pool of ${name} on ${chain} and keep it there ${hold} weeks; a position that survives several fee epochs is the record a future distribution would measure.`,
      `Route 2-3 swaps a week, about ${small} of volume in total, through the own interface of ${name} on ${chain}; steady organic volume matters more than one large trade.`,
      `Stake the LP receipt in the farm or gauge of ${name} if one is offered, vote with it when governance opens, and rebalance the position once a month as prices drift.`,
      `Watch the points or incentives page of ${name} weekly from week 4, keep the liquidity in through any announced snapshot, and withdraw over 1-2 weeks after a claim window opens.`,
    ];
  } else if (family === 'perps') {
    steps = [
      `Deposit ${range} of USDC as margin on ${name} via ${chain} and hold the account ${hold} weeks; a funded account with a long, steady history is what a future distribution would measure.`,
      `Open 2-3 small hedged trades a week on ${name}, about ${small} of notional each, and close them flat; regular completed trades show real use without directional gambling.`,
      `Put about ${small} into the house vault or liquidity pool of ${name} if one is offered, and leave it for at least 6 weeks so the deposit spans more than one rewards epoch.`,
      `Check the points page of ${name} weekly from week 4, keep trading lightly until a season end is announced, and withdraw the margin over 1-2 weeks after any claim opens.`,
    ];
  } else if (family === 'yield') {
    steps = [
      `Deposit ${range} into the main vault of ${name} on ${chain} and hold the shares ${hold} weeks; a balance that stays through several harvests is the record a future distribution would measure.`,
      `Move about ${small} into a second strategy or vault of ${name} for 4-6 weeks, then consolidate back; using more than one product shows the account is a real user, not a passer-by.`,
      `Compound the vault rewards back into ${name} once a month and vote in its governance on ${chain} when polls open; keep every action in one wallet so the history stays attributable.`,
      `Read the points or rewards page of ${name} weekly from week 4, hold the shares until a snapshot or season end is announced, and redeem over 1-2 weeks once a claim window opens.`,
    ];
  } else if (family === 'staking') {
    steps = [
      `Stake ${range} of the native asset of ${chain} through ${name} and hold the liquid receipt ${hold} weeks; a long, unbroken stake is the record a future distribution would measure.`,
      `Use the receipt token of ${name} in one partner money market on ${chain}: supply about ${small} of it as collateral for 4-6 weeks, then unwind; the receipt working in a second protocol deepens the record.`,
      `Top the stake up by about ${small} once a month rather than in a single lump, and claim staking rewards as they accrue so the wallet shows continuous, ordinary use of ${name}.`,
      `Follow the points or airdrop page of ${name} weekly from week 4, keep the stake in place through any announced snapshot, and unstake over the unbonding period of the protocol after claiming.`,
    ];
  } else if (family === 'restaking') {
    steps = [
      `Restake ${range} of liquid staking tokens through ${name} on ${chain} and hold the position ${hold} weeks; restaked balance held across many epochs is the record a future distribution would measure.`,
      `Delegate about ${small} of the restake to one or two operators that ${name} lists, and leave the delegation untouched for at least 6 weeks so it spans full reward epochs.`,
      `Claim the points or rewards of ${name} weekly if its dashboard offers them, and add about ${small} more restake once a month instead of moving the whole position at once.`,
      `Watch the points page and season announcements of ${name} weekly from week 4, hold through any snapshot, and withdraw over 2-3 weeks once a claim window opens, allowing for the exit queue.`,
    ];
  } else if (family === 'bridge') {
    steps = [
      `Bridge ${range} of USDC or ETH through ${name} to ${chain} and keep the funds working on the far side for ${hold} weeks; routed volume that stays is the record a future distribution would measure.`,
      `Make one return trip a month of about ${small} through ${name}, alternating directions, so the wallet shows regular two-way use rather than a single crossing.`,
      `Use the bridged funds in one destination app on ${chain} for 2-4 weeks at a time, a deposit or a swap, so each trip ends in real activity and not an idle balance.`,
      `Check the points or rewards page of ${name} weekly from week 4, keep bridging lightly until a season end is announced, and claim before routing the balance home over 1-2 weeks.`,
    ];
  } else if (family === 'cdp') {
    steps = [
      `Open a vault on ${name} via ${chain}: deposit ${range} of collateral, mint the stablecoin at under half the maximum the vault allows, and hold the vault ${hold} weeks; a conservative, long-lived vault is the record a future distribution would measure.`,
      `Put about ${small} of the minted stablecoin into its main pool or savings rate on ${chain} for 4-6 weeks, so the minted supply works instead of sitting idle in the wallet.`,
      `Check the collateral ratio of the ${name} vault every week, top up about ${small} if it drifts toward liquidation, and vote in the governance of ${name} when polls open.`,
      `Follow the points or rewards page of ${name} weekly from week 4, keep the vault open through any announced snapshot, and repay and close over 1-2 weeks once a claim window opens.`,
    ];
  } else {
    steps = [
      `Use the core product of ${name} on ${chain} with ${range} of capital, deposited or routed through the main flow its app offers, and keep the position ${hold} weeks; steady use is the record a future distribution would measure.`,
      `Complete the quests or points tasks that ${name} itself publishes, about one a week for 6-8 weeks, spending roughly ${small} in fees and small positions as the tasks require.`,
      `Vote in the governance of ${name} on ${chain} whenever a poll opens and hold a small working balance for the whole season, so the wallet reads as a continuing user, not a one-day visitor.`,
      `Read the announcements and rewards page of ${name} weekly from week 4, keep the position until a snapshot or season end is announced, and unwind over 1-2 weeks after any claim opens.`,
    ];
  }
  if (p.chains.length > 1) {
    steps[2] = `${steps[2]} Repeat the core action on a second of the ${p.chains.length} chains of ${name} from week 3, so the record is not single-chain.`;
  }
  return steps.map((s) => s.trim());
}

// ---------------------------------------------------------------- the board

/** One row of board.json: the ranked board's row, with the model's arithmetic kept beside its claim. */
interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  years_tokenless: number | null;
  multiple: number;
  growth_factor: number;
  years_factor: number;
  category_peers: number;
  category_median_multiple: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  farm_steps: string[];
}

/** The board: every tokenless protocol scored, sorted by implied value, ranks assigned once, at the end. */
function buildBoard(snapshot: Snapshot): { rows: BoardRow[]; bases: ReturnType<typeof peerBases> } {
  const bases = peerBases(snapshot);
  let latestListedMs = 0;
  for (const p of snapshot.protocols) {
    if (p.listed_at === null) continue;
    const ms = Date.parse(`${p.listed_at}T00:00:00Z`);
    if (Number.isFinite(ms) && ms > latestListedMs) latestListedMs = ms;
  }
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isTokenless)
    .map((p) => {
      const basis = bases.byCategory.get(p.category);
      const s = score(p, basis, bases.fallback, latestListedMs);
      return { p, basis, s };
    });
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const rows = scored.map(({ p, basis, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    years_tokenless: s.years,
    multiple: s.multiple,
    growth_factor: s.growth,
    years_factor: s.yearsFactor,
    category_peers: basis === undefined ? 0 : basis.peers,
    category_median_multiple: basis === undefined ? null : basis.median,
    watchlist: watch.has(p.slug),
    implied_value_usd: s.implied,
    farm_steps: farmSteps(p),
  }));
  return { rows, bases };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values and farm steps. */
function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(rows.map((r) => r.slug));
  if (slugs.size !== rows.length) return 'the board holds a slug twice';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.rank !== i + 1) return `row ${i} carries rank ${r.rank}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    const recomputed = Math.max(1, Math.round(r.tvl_usd * r.multiple * r.growth_factor * r.years_factor));
    if (recomputed !== r.implied_value_usd) return `${r.slug} claims ${r.implied_value_usd} but its own factors give ${recomputed}`;
    if (i > 0 && r.implied_value_usd > rows[i - 1]!.implied_value_usd) return `${r.slug} outranks the row above it on implied value`;
    if (r.farm_steps.length !== 4) return `${r.slug} has ${r.farm_steps.length} farm steps, not 4`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
      if (t !== s) return `${r.slug} has an untrimmed farm step`;
    }
  }
  if (rows.length >= 2 && rows[0]!.implied_value_usd === rows[rows.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  return null;
}

// ---------------------------------------------------------------- the dashboard data

/**
 * The dashboard's data file, zdata.js: the board in compact arrays (rank is the array order), the
 * category table the detail view reads its peer basis from, the headline stats, and a dictionary of
 * the farm steps — each unique step string once, rows holding indexes into it. The page expands the
 * indexes back to the exact strings board.json carries.
 */
function dataScript(rows: BoardRow[], snapshot: Snapshot, bases: ReturnType<typeof peerBases>): string {
  const catIndex = new Map<string | null, number>();
  const cats: [string | null, number, number | null, number][] = [];
  for (const r of rows) {
    if (catIndex.has(r.category)) continue;
    catIndex.set(r.category, cats.length);
    cats.push([r.category, r.category_peers, r.category_median_multiple, r.multiple]);
  }
  cats.sort((a, b) => {
    const an = a[0] ?? '';
    const bn = b[0] ?? '';
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  cats.forEach((c, i) => catIndex.set(c[0], i));

  const stepIndex = new Map<string, number>();
  const stepTable: string[] = [];
  const stepRef = (s: string): number => {
    const at = stepIndex.get(s);
    if (at !== undefined) return at;
    stepIndex.set(s, stepTable.length);
    stepTable.push(s);
    return stepTable.length - 1;
  };

  const compact = rows.map((r) => [
    r.slug,
    r.name,
    catIndex.get(r.category)!,
    r.tvl_usd,
    r.change_7d,
    r.listed_at,
    r.years_tokenless,
    r.growth_factor,
    r.years_factor,
    r.implied_value_usd,
    r.watchlist ? 1 : 0,
    r.chains.slice(0, 3),
    r.chains.length,
    r.farm_steps.map(stepRef),
  ]);
  const multiples = rows.map((r) => r.multiple).sort((a, b) => a - b);
  const data = {
    version: MODEL_VERSION,
    as_of: snapshot.as_of,
    stats: {
      tracked: rows.length,
      watchlist: rows.filter((r) => r.watchlist).length,
      median_multiple: median(multiples),
      peers: bases.peerCount,
      fallback_multiple: bases.fallback,
    },
    cats,
    steps: stepTable,
    rows: compact,
  };
  return `window.RADAR=${JSON.stringify(data)};\n`;
}

// ---------------------------------------------------------------- the run

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { rows, bases } = buildBoard(snapshot);
const issue = boardIssue(rows, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows })}\n`);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
writeFileSync(join(out, 'dashboard', 'zdata.js'), dataScript(rows, snapshot, bases));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const top = rows[0]!;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${rows.length} pre-token rows scored, ${bases.peerCount} tokened peers as the basis\n` +
    `token radar: top of the board is ${top.slug} at ${money(top.implied_value_usd)} (TVL ${money(top.tvl_usd)} x ${top.multiple} multiple)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'dashboard')} (${dashFiles.length + 1} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
