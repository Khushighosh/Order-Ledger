// evaluate.mjs
// Usage: node evaluate.mjs [--model qwen2.5:7b] [--only 1,5,9] [--verbose] [--file ./test_chats.json]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extractOrder, DEFAULT_MODEL } from "./extract.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const model = opt("model", DEFAULT_MODEL);
const only = opt("only", null)?.split(",").map(Number);
const file = opt("file", "./test_chats.json");
const verbose = args.includes("--verbose");

const { meta, cases: allCases } = JSON.parse(readFileSync(file, "utf8"));
const cases = only ? allCases.filter((c) => only.includes(c.id)) : allCases;

// ---------- comparison helpers ----------
const norm = (v) => (v == null ? null : String(v).trim().toLowerCase());
const words = (s) => (norm(s) ?? "").split(/\W+/).filter((w) => w.length >= 3);

function nameMatch(a, b) {
  const x = norm(a) ?? "";
  const y = norm(b) ?? "";
  if (x.includes(y) || y.includes(x)) return true;
  const wb = new Set(words(b));
  return words(a).some((w) => wb.has(w));
}

function itemsMatch(exp, act) {
  if (!Array.isArray(act) || exp.length !== act.length) return false;
  const used = new Set();
  return exp.every((e) => {
    const j = act.findIndex(
      (a, i) =>
        !used.has(i) &&
        nameMatch(e.name, a.name) &&
        (e.qty ?? null) === (a.qty ?? null) &&
        norm(e.unit) === norm(a.unit)
    );
    if (j < 0) return false;
    used.add(j);
    return true;
  });
}

const FIELDS = [
  "customer", "phone", "items", "delivery_date", "delivery_time",
  "amount", "paid", "status", "needs_review",
];

function score(expected, got) {
  const result = {};
  for (const f of FIELDS) {
    result[f] = f === "items" ? itemsMatch(expected.items, got?.items) : norm(expected[f]) === norm(got?.[f]);
  }
  return result;
}

// ---------- run ----------
const fieldHits = Object.fromEntries(FIELDS.map((f) => [f, 0]));
const tagStats = {};
const details = [];
let exactCases = 0;
let totalMs = 0;

console.log(`Model: ${model} | reference date: ${meta.reference_date} | cases: ${cases.length}\n`);

for (const c of cases) {
  const start = Date.now();
  let got = null;
  let error = null;
  try {
    got = await extractOrder(c.chat, { model, today: meta.reference_date });
  } catch (e) {
    error = e.message;
  }
  const ms = Date.now() - start;
  totalMs += ms;

  const s = score(c.expected, got);
  const wrong = FIELDS.filter((f) => !s[f]);
  const hits = FIELDS.length - wrong.length;
  if (wrong.length === 0) exactCases++;
  for (const f of FIELDS) if (s[f]) fieldHits[f]++;
  for (const t of c.tags) {
    tagStats[t] ??= { hit: 0, total: 0 };
    tagStats[t].hit += hits;
    tagStats[t].total += FIELDS.length;
  }

  const mark = wrong.length === 0 ? "PASS" : "FAIL";
  console.log(`#${String(c.id).padStart(2)} ${mark} ${hits}/${FIELDS.length}  ${ms}ms  ${error ? "ERROR: " + error : wrong.join(", ")}`);
  if (verbose && wrong.length) {
    for (const f of wrong) {
      console.log(`      ${f}: expected ${JSON.stringify(c.expected[f])}  got ${JSON.stringify(got?.[f])}`);
    }
  }
  details.push({ id: c.id, tags: c.tags, ms, error, wrong, got });
}

const pct = (a, b) => `${((100 * a) / b).toFixed(0)}%`;
console.log("\nPer field:");
for (const f of FIELDS) console.log(`  ${f.padEnd(14)} ${pct(fieldHits[f], cases.length)}`);

console.log("\nPer tag (field-level accuracy):");
for (const [t, v] of Object.entries(tagStats).sort()) console.log(`  ${t.padEnd(28)} ${pct(v.hit, v.total)}`);

const fieldTotal = Object.values(fieldHits).reduce((a, b) => a + b, 0);
console.log(`\nField accuracy: ${pct(fieldTotal, cases.length * FIELDS.length)}`);
console.log(`Orders fully correct: ${exactCases}/${cases.length} (${pct(exactCases, cases.length)})`);
console.log(`Average latency: ${Math.round(totalMs / cases.length)} ms per order`);

// Save results so you can quote real numbers in your post.
mkdirSync("results", { recursive: true });
const out = `results/${model.replace(/[^a-z0-9.]+/gi, "_")}-${Date.now()}.json`;
writeFileSync(out, JSON.stringify({ model, fieldHits, exactCases, total: cases.length, details }, null, 2));
console.log(`\nSaved ${out}`);
