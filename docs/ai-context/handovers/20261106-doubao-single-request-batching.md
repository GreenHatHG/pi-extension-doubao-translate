---
created_at: 2026-11-06
updated_at: 2026-11-06
topic: doubao-single-request-batching
status: resolved
affected_modules: [src/index.ts]
tags: [doubao, translate, batching, marker-split, bilingual-interleave]
---

# Doubao Translate: One Request Per Reply (Numbered Marker Batching)

## 1. Context & Problem
The doubao server is a plain HTTP API (`POST /translate`, no system-prompt control). The old `translateText()` fired one request per prose chunk, so a reply with 3 code fences = up to 4 requests. Too many requests risks getting the account blocked. Goal: one request per assistant reply, code fences never translated.

## 2. Pitfalls & Failed Attempts (Gotchas - DO NOT REPEAT)
- **Attempt**: `Promise.all` per prose chunk (original design).
  - **Failure Reason**: N requests per reply; rate-limit/block risk.
- **Attempt**: Ask the model to preserve a `@@SPLIT@@` marker.
  - **Failure Reason**: Doubao server is a fixed API with no prompt injection point. Nothing tells it to keep the marker. Rejected by user.
- **Attempt**: Retry a chunk individually when its marker is missing.
  - **Failure Reason**: Defeats the batching goal; retry storms increase block risk. Rule: never retry. (SUPERSEDED 2026-11-06: doubao does drop 【1】 in practice; a bounded per-segment retry replaced the inline-notice-only path — see Section 3.)
- **Attempt**: One segment per code-fence gap only.
  - **Failure Reason**: A reply with no code fences became ONE giant segment, so its translation rendered as a single block under the whole reply instead of per-paragraph双语.

## 3. Decision & Verified Solution
- **Chosen Approach**: Merge all translatable prose chunks into ONE request body with numbered CJK markers `【1】...【2】...`. These survive Chinese translation naturally (they are CJK punctuation). Split the reply back on `【n】`. Single-chunk replies skip markers entirely (plain prose).
- **Key Changes**: `src/index.ts` — replaced per-chunk `Promise.all` with `buildRequest()` + `splitTranslation()`. Code fences still extracted by `splitCode()` and spliced back untouched.
- **Bilingual interleave (2026-11-06)**: `splitCode()` now also splits prose into paragraphs (`/\n\s*\n/`); each paragraph is its own marker segment. `reassemble()` emits each English paragraph followed by its Chinese. Headings/short paras (< MIN_LENGTH) stay untranslated. User wanted paragraph-level对照, not a full-reply translation block.
- **Per-segment retry (2026-11-06)**: doubao sometimes drops or merges 【1】. Slots that come back as the missing notice are retried individually (no markers, parallel via semaphore, `fillMissing()`); the inline notice shows only if that retry also fails.
- **Failure display rule (user decision)**: A segment whose marker is missing keeps its slot but shows `*(translation unavailable: segment N missing from response)*` — italic + parens, same style as the server-unreachable notice, so error text can't be mistaken for translation prose. If the reply has NO markers at all, drop the whole translation and show original (returns `null`).
- **Minimal Code / Command Reference**:
  ```ts
  const MARKER_RE = /【(\d+)】/g;
  // build: idxs.map((partIdx, i) => `【${i + 1}】${parts[partIdx]}`).join("\n\n")
  // split: walk MARKER_RE, slice between markers into a Map<number,string>;
  //        missing segments -> missingNotice(n); empty Map -> null (no retry)
  ```

## 4. Hard Constraints for Future AI
- NEVER send more than 1 HTTP request per assistant reply to doubao (except bounded per-segment retries for dropped markers — at most one small request per missing segment).
- ALWAYS split prose into paragraphs, not just at code fences, or bilingual对照 degrades to a full-reply block.
- ALWAYS keep `splitCode()` and `reassemble()` paragraph-splitting regexes identical (`/\n\s*\n/`), or part indexes desync and translations land under the wrong paragraph.
- ALWAYS use `*(...)*` italic-paren style for any inline error text so it can't be confused with translation prose.
- ALWAYS keep fenced code blocks out of the request body; splice them back byte-identical (keep surrounding whitespace — trimming it breaks the markdown fence).
- No length cap for now (user decision); revisit only if the server rejects long bodies.
- User misconception to correct if it resurfaces: "it's already one request" is FALSE for replies with code fences — old code was one request per chunk.
