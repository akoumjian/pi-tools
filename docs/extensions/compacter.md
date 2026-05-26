# compacter

## Purpose

Replace Pi's single-shot compaction summarizer with a chunked recursive summarizer. Pi still owns the cut point, writes the normal `CompactionEntry`, and reloads the session; Compacter only intercepts `session_before_compact` to generate a safer summary when the content to summarize would exceed the active model's context window.

## Provides

Command:

- `/compacter [--model provider/model] [instructions]` — run one manual chunked compaction. With no arguments, this is the default action.
- `/compacter status` — show whether the hook is enabled and which model is active.
- `/compacter on|off|toggle` — enable or disable the hook for auto-compaction and built-in `/compact` during this extension runtime.

Side effects:

- Subscribes to `session_before_compact`.
- When enabled, auto-compaction and built-in `/compact` use chunked summarization.
- Manual `/compacter` always uses chunked summarization, even if the runtime hook is disabled.

No LLM-callable tools are registered.

## Behavior

1. Pi prepares compaction normally: it selects the first kept entry, calculates `tokensBefore`, carries any previous summary, and extracts current file operations.
2. Compacter chooses a summarizer model:
   - default: the active Pi model;
   - manual one-run override: `/compacter --model provider/model`.
3. It serializes messages with Pi's normal `convertToLlm()` + `serializeConversation()` path.
4. It splits serialized content into bounded chunks sized from the selected model's context window and Pi's compaction reserve.
5. It summarizes chunks sequentially with provider `maxRetries: 0`, then recursively merges partial summaries until one final structured summary fits.
6. It appends cumulative `<read-files>` and `<modified-files>` tags to the final summary.
7. Pi writes the returned compaction as a normal extension-provided `CompactionEntry` and reloads context from `firstKeptEntryId`.

Split turns are handled the same way Pi handles them: history and the oversized turn prefix are summarized separately, then merged under `**Turn Context (split turn):**`.

## Details shape

Compacter stores file-operation lists in `details` so later Compacter runs can keep file tracking cumulative even though Pi marks hook-provided compactions with `fromHook`.

```ts
{
  compacter: {
    version: 1,
    model: string,          // provider/model used for summarization
    chunks: number,         // raw chunks summarized
    modelCalls: number,     // total summarization/merge calls
    reductionPasses: number
  },
  readFiles: string[],
  modifiedFiles: string[]
}
```

## Setup

None. Compacter intentionally has no package default summarizer model. Configure normal Pi models/auth, then use the current active model or pass a one-run `--model` for manual compaction.

To avoid hidden provider SDK retry sleeps, set Pi's provider retry setting in your profile if desired:

```json
{
  "retry": {
    "provider": {
      "maxRetries": 0
    }
  }
}
```

Pi's own visible retry loop remains separate.

## Notes / gotchas

- Compacter does not mutate session JSONL directly.
- Compacter does not trim normal context outside Pi's native compaction flow.
- `/compacter --model ...` changes only the summarizer used by Compacter's hook for that manual run; it does not install a persistent compaction model.
- Pi currently resolves auth for the active model before firing `session_before_compact`, so the active model still needs usable auth even when a manual `--model` override is provided.
