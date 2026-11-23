# pi-session-title

A [Pi](https://github.com/earendil-works/pi) extension that names each session after its task, the way Codex and Claude Code do, and makes that name the terminal title. Terminal tabs (Rex, Ghostty, tmux, iTerm) then say what each session is doing instead of `π - my-project`.

```
you:  In one sentence, what does the Unix tee command do?
tab:  In one sentence, what does the Unix tee command do?   ← at once
tab:  Explain Unix tee command                              ← a few seconds later
```

## Install

```bash
pi install git:github.com/justinberiot/pi-session-title
```

Restart Pi or run `/reload` in open sessions.

## How it works

- **First message.** In an unnamed session, the terminal title shows the first line of your first message straight away. In the background, a model writes a short title, and that becomes the session's name. The name also shows in Pi's footer and in `/resume`.
- **Codex's rules.** The title request is ported from Codex's TUI (`codex-rs/tui/src/app/thread_title.rs`): at most 36 characters, under five words where possible, starting with an imperative verb, ticket references kept, written in your language. The model sees at most 960 bytes of your message.
- **Your names win.** A session named with `/name`, `pi -n`, or by another extension is never renamed. A rename while a title is still being written cancels it, and the model request is aborted.
- **Failures.** If the model fails, times out after 90 seconds, or answers with something unusable, the first line is kept as the name and Pi shows a warning.
- **Terminal title.** The title is the session's name alone, or the folder name until there is one, not Pi's `π - name - folder`.

## Commands

| Command | Does |
| --- | --- |
| `/retitle` | Writes a new title from the session's latest eight messages, preferring the latest request. |
| `/retitle <name>` | Sets the name directly. |

## Model

Titles are written with the session's current model. To use another model, set `sessionTitle.model` in `~/.pi/agent/settings.json` to `provider/model-id`:

```json
{
  "sessionTitle": { "model": "openai/gpt-6-luna" }
}
```

A small, fast model is the best fit. The request is sent with low reasoning, no prompt caching, and no session ID, so providers keep it apart from the conversation. For example, [pi-claude-cli](https://github.com/dmmulroy/pi-claude-cli) starts a short-lived process for it instead of reusing the conversation's own.

## Differences from Codex

- **Answer format.** Codex forces the title into a JSON schema through its API. Not every Pi provider can do that, so the prompt asks for `{"title": "..."}`, and a code fence around it or a single plain line is also accepted.
- **`/retitle` budget.** Codex fits eight recent messages into 960 bytes, which leaves about ten bytes of each after the instructions and markup. `/retitle` gets 2,400 bytes instead.

## Development

```bash
npm install
npm run check   # tsc --noEmit, then node --test
```

The layout follows [pi-claude-cli](https://github.com/dmmulroy/pi-claude-cli):

- `index.ts` holds the Pi wiring and does not import Effect, so Pi starts without loading it.
- `src/title-runtime.ts` owns an [Effect 4](https://effect.website) `ManagedRuntime`. It is loaded on the first message and disposed on `session_shutdown`. Each title request is one fiber, and interrupting the fiber aborts the model call.
- `src/title-text.ts` holds the pure text rules. `src/title-model.ts` holds the model service. `src/title-generator.ts` holds the request workflow.

## License

MIT
