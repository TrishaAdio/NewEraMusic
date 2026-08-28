# livegen

Watch a model write code, token by token, in your terminal. Zero runtime
dependencies — no install step, just Node 22+.

```bash
cp .env.example .env      # fill in LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
node --experimental-strip-types src/cli.ts "write a rate limiter in typescript"
```

```
────────────────────────────────────────────────────────────
mock-model via 127.0.0.1:8787
────────────────────────────────────────────────────────────

Here is a debounce implementation.

┌─ typescript ───────────────────────────────────
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}
└────────────────────────────────────────────────

The timer is captured per closure, so each debounced function is independent.

────────────────────────────────────────────────────────────
elapsed 0.7s  │  ttft 0.03s  │  tokens 58  │  rate 82.3 t/s  │  finish stop
```

Code inside fenced blocks is highlighted; prose outside them is dimmed, so your
eye lands on the code. `LLM_OUT_FILE=out.ts` writes the largest code block to
disk when the stream finishes.

## Provider-agnostic on purpose

The base URL is configuration, so the same code works against OpenAI, Azure,
OpenRouter, Groq, a local llama.cpp server, or a reseller panel. Nothing here is
vendor-specific.

That is a deliberate hedge. Unofficial resale endpoints get keys revoked and
hostnames rotated without notice — when yours stops working, you change one
environment variable rather than rewriting a client.

## The key is never in the code

Read from `LLM_API_KEY` only. Not a CLI flag (shell history), not a config file
(commits), not a function default. It is masked whenever it is displayed:

```
key sk-moc******************-key
```

Config is validated at startup and reports every problem at once:

```
Invalid configuration:
  LLM_API_KEY is not set (put it in .env, which is gitignored)
  LLM_BASE_URL is not set, e.g. https://api.example.com/v1
  LLM_MODEL is not set, e.g. claude-opus-5
```

Plain `http://` to a remote host is rejected, because the key would cross the
wire in cleartext. Localhost is allowed, for local models and the mock.

**If a key has ever been pasted into a chat, an issue, or a log, it is
compromised. Rotate it — do not keep using it.**

## Why the SSE parser is its own file

Chunk boundaries from the network have no relationship to message boundaries in
the protocol. All of these happen in production and all of them are tested:

| Case | Why it breaks naive clients |
|---|---|
| One `data:` line split across chunks | `chunk.split('\n')` loses the tail |
| Several events in one chunk | Only the first gets parsed |
| JSON split mid-string or mid-escape | `JSON.parse` throws on a valid stream |
| Multi-byte character torn across chunks | Per-chunk `toString()` yields `U+FFFD` |
| `\r\n` from a normalising proxy | Splitting on `\n\n` never matches |
| `: ping` keep-alive lines | Fed to `JSON.parse`, throws |
| `data: [DONE]` | Not JSON, throws |
| Leading spaces in streamed code | Over-trimming destroys indentation |

Decoding uses a streaming `TextDecoder`, and exactly one leading space is
stripped per the spec — not `trim()`, which would corrupt indentation in code.

## Error classification

`ProviderError` and `StreamProtocolError` are distinct because the remedies are
opposite. A provider error frame proves the endpoint **is** compatible and the
request was wrong. Malformed output means the endpoint is wrong.

```
✕ HTTP 401: ... — key rejected; it may be revoked or out of quota
✕ HTTP 500: {"error":{"message":"upstream capacity exceeded"}}
✕ Provider error (context_length): context length exceeded — shorten the prompt
✕ Stream produced nothing for 1500ms — raise LLM_STALL_TIMEOUT_MS if the model is just slow
```

The stall watchdog is not a total-request timeout. Long generations are
legitimate; silent connections are not. Conflating them either kills working
requests or hangs forever on dead ones.

## Testing without a key

`mock/server.ts` is a local OpenAI-compatible endpoint that reproduces failure
modes a real provider will not produce on demand:

| Route | Behaviour |
|---|---|
| `/v1` | Normal stream |
| `/v1-split` | Every frame chopped into 3-byte writes |
| `/v1-unicode` | Multi-byte characters torn across boundaries |
| `/v1-crlf` | CRLF endings plus keep-alive comments |
| `/v1-error` | Valid content, then a mid-stream error frame |
| `/v1-stall` | Sends a little, then silence forever |
| `/v1-http-500` | Fails before the stream starts |

```bash
npm test          # 28 tests, no key required
npm run typecheck
npm run mock      # then point LLM_BASE_URL at http://127.0.0.1:8787/v1
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Request or stream failed |
| 64 | No prompt given |
| 78 | Invalid configuration |
| 130 | Aborted with Ctrl-C |

Ctrl-C aborts the request rather than killing the process, so stats and
`LLM_OUT_FILE` are still written.
