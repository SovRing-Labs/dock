// dock/select.js — selection over the catalog.
//
// Stage 1 (this file) is deliberately simple and deliberately ABLE TO ABSTAIN:
// `search_tools` returns `results: []` plus `confidence` below the floor when
// nothing clears the bar. That is the property the market lacks — keyword search
// must always return top-k, so it hands a model plausible-looking wrong tools.
// A confidence with an abstention lets us return nothing instead.
//
// Scoring is BM25-ish over name + description. It is the baseline to measure
// against, not the endgame: the endgame is k-NN over marks with the same
// abstain-when-nothing-closes contract.

const K1 = 1.2;
const B = 0.75;

/**
 * English + MCP stopwords.
 *
 * Without these, a query like "read a file" matches "a" against every tool in
 * the catalog and manufactures ties between unrelated candidates — which then
 * trip the ambiguity gate and make a perfectly clear query abstain. That is the
 * opposite of the intended failure mode: stopwords should be invisible, not
 * decisive. Kept deliberately small; this is stage-1 lexical selection, not a
 * natural-language front end.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "but", "by", "can", "do",
  "does", "for", "from", "get", "give", "has", "have", "how", "i", "if", "in",
  "into", "is", "it", "its", "me", "my", "need", "no", "not", "of", "on", "or",
  "our", "out", "please", "should", "so", "some", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "to", "up", "us", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your",
]);

/**
 * Conservative suffix stripper (stage 2).
 *
 * Stage 1 matched tokens exactly, so "read" never matched "reading" and a model
 * asking to "read" a file had to guess the exact verb the tool author used. This
 * is morphology only — no embeddings, no model, still zero dependencies — and it
 * is deliberately timid, because the failure mode here is worse than a miss: an
 * over-eager stemmer fuses unrelated tools into a tie, the tie trips the
 * ambiguity flag, and a clear query starts abstaining.
 *
 * Guards, each of which exists to prevent one observed failure:
 *  - words of 3 or fewer characters are never touched, so "bus"/"run"/"set" stay
 *    distinct;
 *  - -s is removed unless it ends in ss/us/is, so "analysis", "status" and
 *    "less" survive intact (stemming "less" to "les" would manufacture a match);
 *  - -ing/-ed only strip when the remaining stem contains a vowel, so "things"
 *    and "bed" are left alone;
 *  - a doubled final consonant is undone ("running" -> "run", not "runn").
 *
 * Both sides of the comparison go through this, index and query alike, so the
 * stems are always comparable.
 */
const VOWEL = /[aeiouy]/;

function undouble(stem) {
  const n = stem.length;
  if (n >= 2 && stem[n - 1] === stem[n - 2] && !VOWEL.test(stem[n - 1])) {
    return stem.slice(0, -1);
  }
  return stem;
}

export function stem(word) {
  const w = String(word ?? "");
  if (w.length <= 3) return w;

  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("es") && /(?:ch|sh|ss|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) return w.slice(0, -1);

  if (w.endsWith("ing") && w.length > 5) {
    const base = w.slice(0, -3);
    if (VOWEL.test(base)) return undouble(base);
    return w;
  }
  if (w.endsWith("ed") && w.length > 4) {
    const base = w.slice(0, -2);
    if (VOWEL.test(base)) return undouble(base);
    return w;
  }
  return w;
}

/**
 * Query-side synonym expansion (stage 2).
 *
 * Curated and small on purpose. A general thesaurus would dilute the signal this
 * whole design depends on; these are the verbs an MCP tool author actually uses
 * that differ from the verb a model reaches for first ("open" for "read",
 * "grep" for "search").
 *
 * Applied to the QUERY ONLY, and deliberately excluded from the evidence
 * ceiling below. That asymmetry is the safety property: a synonym can raise a
 * score but can never lower `top/ceiling`, so expansion can improve recall
 * without making the abstain gate hair-trigger or swallowing the barrier that
 * keeps irrelevant tools out.
 */
const SYNONYMS = {
  read: ["open", "load", "parse", "cat", "view"],
  write: ["save", "create", "store", "persist"],
  list: ["enumerate", "dir", "ls"],
  search: ["find", "query", "lookup", "grep"],
  delete: ["remove", "unlink", "destroy"],
  fetch: ["download", "curl", "http"],
  execute: ["run", "invoke", "exec"],
  edit: ["modify", "patch", "change", "update"],
  create: ["make", "add", "new"],
  get: ["fetch", "obtain", "retrieve"],
  send: ["post", "deliver", "transmit"],
};

/**
 * The synonym table is treated as an EQUIVALENCE CLASS, not a directed edge.
 *
 * A/B measurement forced this. With one-directional expansion the table was
 * inert on the live catalog — 0 recall gained — because it only helped when the
 * QUERY used the canonical word and the DOCUMENT used the variant ("write"
 * reaching a doc that says "save"), and that is the rarer direction. A model
 * asking to "save a note" is asking a `write` tool, and nothing in that query
 * contains the string "write".
 *
 * The graph is undirected, so "save" and "write" are the same class, and closure
 * is transitive: create -> make -> add -> new all join one class.
 */
const CLASSES = (() => {
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (const [head, tails] of Object.entries(SYNONYMS)) {
    for (const tail of tails) link(stem(head), stem(tail));
  }
  // Transitive closure: seed from each node, walk until nothing new appears.
  const closed = new Map();
  for (const start of adj.keys()) {
    if (closed.has(start)) continue;
    const group = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.pop();
      for (const next of adj.get(cur) ?? []) {
        if (group.has(next)) continue;
        group.add(next);
        queue.push(next);
      }
    }
    for (const t of group) closed.set(t, group);
  }
  return closed;
})();

function expand(tokens) {
  const out = [];
  for (const t of tokens) {
    for (const s of CLASSES.get(t) ?? []) {
      if (s !== t) out.push(s);
    }
  }
  return out;
}

function tokenize(s) {
  return String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean)
    .map(stem)
    // Stopword check runs on the stem as well as the raw token, so "gets" and
    // "wills" are dropped the same way "get" and "will" already were.
    .filter((t) => !STOPWORDS.has(t));
}

/**
 * Build IDF over the catalog once per refresh. Cheap: catalogs are tens to
 * hundreds of entries, and we rebuild on refresh rather than per query.
 */
export function buildIndex(catalog) {
  const docs = catalog.map((entry) => ({
    entry,
    tf: new Map(),
    len: 0,
  }));

  const df = new Map();
  for (const d of docs) {
    const toks = tokenize(`${d.entry.qname} ${d.entry.description}`);
    d.len = toks.length;
    for (const t of toks) {
      d.tf.set(t, (d.tf.get(t) ?? 0) + 1);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }

  const N = docs.length || 1;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));

  return { docs, idf, N, avgLen };
}

/**
 * Score every doc against the query.
 *
 * Returns { scored, ceiling, tokens }. `ceiling` is the largest score this query
 * COULD produce against any single doc — every query term present exactly once in
 * a maximally favourable doc. Callers normalise `score / ceiling` instead of
 * comparing raw BM25 to a fixed number, because raw BM25 is not comparable
 * across catalog sizes: a term appearing in every doc of a 2-doc catalog gets an
 * IDF near zero, so a perfect match scores almost nothing and an absolute floor
 * would reject it. The ceiling is scale-free.
 */
export function scoreQuery(index, query) {
  const qTokens = [...new Set(tokenize(query))];
  // Synonyms widen the MATCH set but not the DEMAND set: scoring sees both, the
  // ceiling sees only what was actually asked for.
  const matchTerms = [...new Set([...qTokens, ...expand(qTokens)])];
  const scored = [];

  for (const d of index.docs) {
    let score = 0;
    for (const t of matchTerms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = index.idf.get(t) ?? 0;
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / index.avgLen))));
    }
    if (score > 0) scored.push({ entry: d.entry, score });
  }

  // Ceiling: length normalisation at its most favourable setting is 1.0 when
  // doc length equals the average, so cap each term's contribution at its idf.
  // Deliberately built from qTokens alone — see `expand`.
  let ceiling = 0;
  for (const t of qTokens) {
    if (index.idf.has(t)) ceiling += index.idf.get(t);
  }

  return { scored, ceiling, tokens: qTokens };
}

/**
 * Search the catalog.
 *
 * `confidence` is the top score normalized by the runner-up's shortfall, so a
 * single strong match can still clear the floor but a flat field of weak
 * matches cannot. When nothing clears `floor`, we abstain: results is empty and
 * `abstained: true`. That is the contract callers should branch on.
 */
export function search(index, query, { k = 8, minEvidence = 0.2, minConf = 0.75 } = {}) {
  const { scored: raw, ceiling, tokens } = scoreQuery(index, query);
  if (raw.length === 0 || ceiling <= 0) {
    return {
      results: [],
      confidence: 0,
      abstained: true,
      reason: tokens.length ? "no lexical overlap" : "query was all stopwords",
    };
  }

  raw.sort((a, b) => b.score - a.score);
  const top = raw[0].score;

  // ABSTAIN only when nothing is relevant. This is the one condition the whole
  // design exists for: keyword search cannot return "nothing matches", so a
  // model is handed plausible-looking wrong tools.
  //
  // Evidence is top/ceiling, not top/floor: "how much of what was asked for did
  // the best match actually cover?" A query whose terms are all rare and all
  // present scores ~1.0; a query where the best match covers a quarter of the
  // requested terms scores ~0.25 and is correctly refused.
  //
  // Clamped at 1: synonym expansion can legitimately push `top` past the
  // ceiling, and a coverage figure above 100% is noise in the response a model
  // reads. The clamp cannot turn a refusal into a hit — it only ever moves a
  // passing number back to full coverage.
  const evidence = Math.min(top / ceiling, 1);
  if (evidence < minEvidence) {
    return {
      results: [],
      confidence: 0,
      abstained: true,
      reason:
        `nothing relevant: best match covers only ${(evidence * 100).toFixed(0)}% ` +
        `of the query (min ${(minEvidence * 100).toFixed(0)}%)`,
    };
  }

  // Confidence is RATIO-based against the runner-up, not difference-based. A
  // difference penalises ties, and ties are ordinary: two tools with similar
  // descriptions score identically, and a difference-based measure would call a
  // clear query ambiguous purely because a second candidate was equally good.
  const second = raw[1]?.score ?? 0;
  const confidence = top > 0 ? 1 - Math.min(second / top, 1) : 1;

  // A tie is NOT abstention. It means "these candidates are equally plausible",
  // which is information the model can act on: return them all, flag the
  // ambiguity, let the model pick. Withholding a set of genuinely relevant
  // tools is a worse failure than offering two when one was wanted.
  const ambiguous = confidence < minConf;

  return {
    results: raw.slice(0, k).map((r) => ({
      qname: r.entry.qname,
      server: r.entry.server,
      tool: r.entry.tool,
      description: r.entry.description,
      inputSchema: r.entry.inputSchema,
      score: Number(r.score.toFixed(3)),
    })),
    confidence: Number(confidence.toFixed(3)),
    abstained: false,
    ambiguous,
    // Present only when ambiguous, so callers can branch without always
    // carrying a field they ignore.
    ...(ambiguous
      ? {
          note:
            `${raw.length} near-equal matches (top ${top.toFixed(2)}, ` +
            `runner-up ${second.toFixed(2)}); treat these as candidates, not a ranking`,
        }
      : {}),
  };
}
