# Order Ledger

Turn messy WhatsApp order chats into a clean order book. It runs entirely on your own computer with an open-weight model, so customer names, phone numbers and prices never leave your laptop.

Built for the Hacktoberfest Open-Source AI Challenge, Week 2 (Side Hustle).

## Who it's for

Home bakers, tiffin and cloud-kitchen sellers, tailors and small shops who take orders over WhatsApp and keep track in a notebook. Their chats are messy: English mixed with Hindi or Kannada, "kal subah", "advance 500 diya", orders that change halfway through. You paste the chat, and the app turns it into a structured order.

## What it does

- Reads a pasted WhatsApp chat (an exported chat, text copied from WhatsApp Web, or lines typed with `C:` for the customer and `S:` for you) and extracts the customer, phone, items, quantities, delivery date and time, total, amount paid and status.
- Shows the result on a review screen. You check and fix it before anything is saved.
- **Schedule:** upcoming orders grouped by day, with "today" and "overdue" markers.
- **Pending payments:** how much is still owed, plus a button that copies a polite reminder you can paste into WhatsApp.
- **All orders:** a table with a CSV export for your accountant.
- Works offline once the model is downloaded.

## Why open models

- **Privacy:** chats contain customer names, phone numbers and prices. Here they are processed on your own machine and saved in a local file.
- **Cost:** there are no per-order API fees. A seller can use it as much as they like.
- **Control:** the model is one setting. We compared a 7B and a 3B model on the same test chats and picked the one that was accurate enough (see Accuracy).

## Quick start

You need:

- [Node.js](https://nodejs.org) 18 or newer (developed on Node 24)
- [Ollama](https://ollama.com), running in the background
- A laptop that can run a 7B model, and about 5 GB of disk space for it

```
ollama pull qwen2.5:7b
git clone https://github.com/Khushighosh/order-ledger.git
cd order-ledger
node server.mjs
```

Then open <http://localhost:3000>. There is nothing to `npm install`. A green "Local model ready" badge at the top right means the app can reach the model.

## Using it

1. Paste a chat into the box. For a WhatsApp chat, use WhatsApp's "Export chat" option (without media) and paste the text, or copy messages from WhatsApp Web.
2. For pasted WhatsApp chats, type your own name exactly as it appears in the chat, so the app knows which lines are yours. The name is remembered for next time.
3. Press **Read order**. On the author's laptop this takes roughly 14 seconds per order with the 7B model.
4. Check the parsed order, fix anything that looks wrong, and save. "See what the model read" shows how your chat was converted.
5. Use the Schedule, Pending payments and All orders tabs to keep track.

Try the "Load sample chat" and "Load WhatsApp-style sample" buttons to see it work without any real data.

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `MODEL` | `qwen2.5:7b` | Which Ollama model to use |
| `OLLAMA_URL` | `http://localhost:11434` | Where Ollama is running |
| `PORT` | `3000` | Port for the web app |

Example, using a different model:

```
# Windows PowerShell
$env:MODEL="llama3.2:3b"; node server.mjs

# macOS / Linux
MODEL=llama3.2:3b node server.mjs
```

## Accuracy

The repo includes two small sets of **synthetic** test chats (fake names and numbers): `test_chats.json` (12 chats) and `fresh_chats.json` (6 chats). Run them yourself:

```
node evaluate.mjs --model qwen2.5:7b --verbose
node evaluate.mjs --file ./fresh_chats.json --model llama3.2:3b
```

The script scores each field (customer, phone, items, dates, amounts, payment, status) against hand-written expected answers and prints accuracy per field and per kind of chat. Results are saved in a `results/` folder.

The short version: the 7B model is accurate enough to be useful when a person checks each order. The 3B model is about twice as fast but makes too many mistakes, and sometimes invents an order when the chat is unclear. Both test sets are small, and the prompt was tuned using them, so treat the numbers as indicative, not as a benchmark. That is why the review screen exists.

## How it works

| File | Purpose |
|---|---|
| `extract.mjs` | Builds the prompt, calls Ollama with a JSON schema so the output is always valid, and cleans up the result |
| `server.mjs` | A small local web server with no dependencies. It stores orders in `orders.json` |
| `index.html` | The whole interface in one file |
| `evaluate.mjs` | The accuracy test runner |
| `test_chats.json`, `fresh_chats.json` | Synthetic test chats with expected answers |

Design choices worth knowing about:

- **Code does the deterministic work, the model does the reading.** Relative dates ("kal", "nale", "aaj", "parso") and phone-number formatting are handled in code. Small models were unreliable at looking up dates, and moving that into code fixed the failures.
- **Structured output.** Ollama constrains the model to a JSON schema, so the app never has to parse free text.
- **A person checks every order.** Nothing is saved until the seller has seen it.
- **Local only.** The server listens on `127.0.0.1`, so only the computer it runs on can open it.

## Privacy

Orders, including the pasted source chat, are saved in `orders.json` next to the app. That file and any CSV exports are listed in `.gitignore`, so they are never committed. Back up and protect that file as you would any customer records.

## Known limitations

- One seller on one computer. There is no login or multi-user support.
- Amounts are assumed to be in rupees.
- It takes about 7 to 15 seconds per order depending on the model, and the first order after a break is slower while the model loads.
- The test chats are synthetic and the WhatsApp import was tested on sample formats. Real exports from some phones or languages may need small adjustments.
- Orders are only as accurate as the model's reading of the chat. Always check the review screen.

## License

MIT. See [LICENSE](LICENSE).
