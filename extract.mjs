// extract.mjs
// Turns a raw WhatsApp order chat into a structured order using a local model served by Ollama.
// Node 18+ (built-in fetch). No dependencies.

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const DEFAULT_MODEL = process.env.MODEL ?? "qwen2.5:7b";

const nullable = (type) => ({ anyOf: [{ type }, { type: "null" }] });

// Ollama constrains the model's output to this schema, so you always get parseable JSON.
export const ORDER_SCHEMA = {
  type: "object",
  properties: {
    customer: nullable("string"),
    phone: nullable("string"),
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          qty: nullable("number"),
          unit: { anyOf: [{ type: "string", enum: ["kg", "pcs", "litre", "box"] }, { type: "null" }] },
          notes: nullable("string"),
        },
        required: ["name", "qty", "unit", "notes"],
      },
    },
    delivery_date: nullable("string"),
    delivery_time: nullable("string"),
    amount: nullable("number"),
    paid: { type: "number" },
    status: { type: "string", enum: ["confirmed", "tentative", "cancelled"] },
    needs_review: { type: "boolean" },
  },
  required: [
    "customer", "phone", "items", "delivery_date", "delivery_time",
    "amount", "paid", "status", "needs_review",
  ],
};

// ---------- Dates: do the calendar maths in code, not in the model ----------
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayISO() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

export function buildCalendar(todayIso) {
  return Array.from({ length: 8 }, (_, offset) => {
    const iso = addDays(todayIso, offset);
    return { offset, iso, weekday: DAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()] };
  });
}

// Relative-date words are resolved here in code and shown to the model next to the original word,
// e.g. "nale 2 litre dosa hittu" becomes "nale (2026-10-14) 2 litre dosa hittu".
// Small models are unreliable at looking these up themselves.
export function annotateDates(text, cal) {
  const rules = [
    [/\bday after tomorrow\b|\bparso\b/gi, cal[2].iso],
    [/\b(?<!after )tomorrow\b|\bkal\b|\bnale\b/gi, cal[1].iso],
    [/\baaj\b|\btoday\b/gi, cal[0].iso],
  ];
  let out = text;
  for (const [re, iso] of rules) out = out.replace(re, (m) => `${m} (${iso})`);
  return out;
}

// ---------- Prompt ----------
function systemPrompt(cal) {
  const table = cal
    .slice(1)
    .map((r) => {
      const tag = r.offset === 1 ? " (tomorrow / kal / nale)" : r.offset === 2 ? " (day after tomorrow / parso)" : "";
      // The last row is the same weekday as today, one week later. Label it so it is never mistaken for today.
      const label = r.offset === 7 ? `next ${r.weekday} (a week from today)` : r.weekday;
      return `- ${label}${tag}: ${r.iso}`;
    })
    .join("\n");

  return `You extract ONE structured order from a WhatsApp chat between a small seller (S) and a customer (C).
The chat may be in English, Hindi/Hinglish, or Kannada written in English letters.
Reply with JSON only, matching the schema. Never add any text outside the JSON.

TODAY IS ${cal[0].weekday} ${cal[0].iso}. "Today", "aaj" and "this evening" all mean ${cal[0].iso}.
Relative dates in the chat are followed by their date in brackets, for example "kal (2026-10-14)". Use that date.
For weekday names, use this table to get YYYY-MM-DD. Never calculate dates yourself:
${table}
An explicit date such as "Nov 7th" means that date in the next occurrence from today.

RULES
1. Use the FINAL state of the order. If the customer changes a quantity, adds or removes an item, output only what was finally agreed.
2. Never invent values. If something is not stated, use null (or [] for items). Do not guess.
3. Quantities: 1 dozen = 12 pcs. Use unit "kg" for weights, "litre" for liquids, "box" for boxes, "pcs" for counted items. Put customisations (flavour, "eggless", text on a cake) in notes.
4. amount = the final total price in INR. Use the total the seller states; if only per-item prices are given, add them up.
5. paid = money the customer has already paid (advance, UPI/GPay/PhonePe sent). "Paid full" means paid = amount. "Pay on delivery" or nothing paid means 0. If the customer says they have paid (for example "paid via gpay") without an amount, paid = amount.
6. phone = 10 digits only (drop +91, spaces and dashes).
7. delivery_time = "HH:MM" (24h) when an exact time is given, otherwise one of morning, afternoon, evening, lunch, or null.
8. status = "cancelled" if the customer cancels, "tentative" if the customer has not confirmed yet, otherwise "confirmed".
9. needs_review = true when the order cannot be fully determined: items missing or unclear (for example "same as last time"), a quantity given as a range, or the customer still deciding. A missing name or phone alone does NOT need review.
10. The same product ordered in different variants (for example two blouses with different necklines) is ONE item with the total qty. Put the variants in notes.
11. customer = the person placing the order (the C speaker). Never use a name that only appears inside the order, such as a name written on a cake.
12. A cancelled order still lists the items that were ordered.`;
}

// Few-shot examples. These are deliberately NOT in test_chats.json, so they don't leak into the evaluation.
function fewShot(cal) {
  const next = (weekday) => cal.slice(1).find((r) => r.weekday === weekday).iso;
  const examples = [
    {
      chat: "C: bhaiya parso 2 dozen jalebi chahiye\nS: 2 dozen = 480\nC: ok, advance 200 bheja. Asha 9000000012",
      out: {
        customer: "Asha", phone: "9000000012",
        items: [{ name: "jalebi", qty: 24, unit: "pcs", notes: null }],
        delivery_date: cal[2].iso, delivery_time: null,
        amount: 480, paid: 200, status: "confirmed", needs_review: false,
      },
    },
    {
      chat: "C: need a cake for sunday\nS: which flavour and what weight?\nC: will tell you tonight",
      out: {
        customer: null, phone: null, items: [],
        delivery_date: next("Sunday"), delivery_time: null,
        amount: null, paid: 0, status: "tentative", needs_review: true,
      },
    },
    {
      chat: "C: 3 kg biryani for friday lunch\nS: 1500\nC: make it 2 kg\nS: 1000 then\nC: ok. Imran 9000000013, will pay cash",
      out: {
        customer: "Imran", phone: "9000000013",
        items: [{ name: "biryani", qty: 2, unit: "kg", notes: null }],
        delivery_date: next("Friday"), delivery_time: "lunch",
        amount: 1000, paid: 0, status: "confirmed", needs_review: false,
      },
    },
  ];
  return examples.flatMap((e) => [
    { role: "user", content: e.chat },
    { role: "assistant", content: JSON.stringify(e.out) },
  ]);
}

// ---------- Main entry point (the web app imports this) ----------
export async function extractOrder(chat, { model = DEFAULT_MODEL, today = todayISO() } = {}) {
  const cal = buildCalendar(today);
  const text = annotateDates(Array.isArray(chat) ? chat.join("\n") : chat, cal);

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: ORDER_SCHEMA,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: systemPrompt(cal) },
        ...fewShot(cal),
        { role: "user", content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const order = JSON.parse(data.message.content);
  // Deterministic clean-up belongs in code, not in the model: keep only the last 10 digits of the phone number.
  if (typeof order.phone === "string") order.phone = order.phone.replace(/\D/g, "").slice(-10) || null;
  return order;
}