/**
 * Codex's title rules (`codex-rs/tui/src/app/thread_title.rs`), with no
 * dependencies: `index.ts` puts them in `set_session_title`'s description
 * before Effect is loaded.
 */

/** The longest title kept, in characters, as in Codex. */
export const TITLE_MAX_CHARS = 36;

/** Codex's title rules after its opening sentence. */
export const TITLE_RULES =
  "Start with an imperative verb. Capitalize only " +
  "the first word unless the user's language, proper nouns, acronyms, or code terms " +
  "require otherwise. Preserve ticket references exactly. Write in the user's language. " +
  "Do not use quotes, markdown, or trailing punctuation.";
