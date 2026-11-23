/**
 * The text rules for session titles, ported from Codex's TUI
 * (`codex-rs/tui/src/app/thread_title.rs`): the instructions the model gets,
 * the bounds on what it sees, the first-line placeholder shown while it
 * works, and the normalization of what it answers.
 *
 * Pure. The only boundary here is the model's answer, which is decoded with
 * `Schema` in `parseGeneratedTitle`.
 */

import { Option, Schema } from "effect";

/** The longest title kept, in characters, as in Codex. */
export const TITLE_MAX_CHARS = 36;

/** The most of the prompt the model sees, in UTF-8 bytes, as in Codex. */
export const TITLE_PROMPT_MAX_BYTES = 960;

/** How many recent messages `/retitle` reads, as in Codex. */
export const TITLE_RECENT_MESSAGES = 8;

/**
 * The most of the conversation request the model sees, in UTF-8 bytes.
 * Larger than Codex's 960: after the instructions and the markup of eight
 * messages, 960 leaves about ten bytes of each message.
 */
export const CONVERSATION_PROMPT_MAX_BYTES = 2_400;

/** The longest placeholder title, in characters, as in Codex. */
const FALLBACK_MAX_CHARS = 60;

/** How much of the first message the placeholder is taken from. */
const FALLBACK_INPUT_MAX_CHARS = 2_000;

/** Codex's instructions, plus the JSON answer Codex gets from a schema. */
const TITLE_INSTRUCTIONS =
  `Generate a concise, single-line task title of at most ${TITLE_MAX_CHARS} characters ` +
  "and under five words where possible. Start with an imperative verb. Capitalize only " +
  "the first word unless the user's language, proper nouns, acronyms, or code terms " +
  "require otherwise. Preserve ticket references exactly. Write in the user's language. " +
  "Do not use quotes, markdown, or trailing punctuation. Do not answer the request.\n" +
  'Reply with only a JSON object of the form {"title": "..."} and nothing else.';

const encoder = new TextEncoder();

/** The UTF-8 length of `text`. */
const byteLength = (text: string): number => encoder.encode(text).length;

/** The longest prefix of `text` within `maxBytes`, never splitting a character. */
const takeBytes = (text: string, maxBytes: number): string => {
  let used = 0;
  let out = "";
  for (const character of text) {
    const size = byteLength(character);
    if (used + size > maxBytes) break;
    used += size;
    out += character;
  }
  return out;
};

/** The longest suffix of `text` within `maxBytes`, never splitting a character. */
const takeLastBytes = (text: string, maxBytes: number): string => {
  const characters = Array.from(text);
  let used = 0;
  let start = characters.length;
  while (start > 0) {
    const size = byteLength(characters[start - 1] ?? "");
    if (used + size > maxBytes) break;
    used += size;
    start -= 1;
  }
  return characters.slice(start).join("");
};

/** Runs of whitespace as single spaces, trimmed. */
const collapseWhitespace = (text: string): string => text.split(/\s+/u).filter(Boolean).join(" ");

/**
 * Markdown reduced to its words: fences, inline code marks, emphasis,
 * heading and list markers, and link targets removed. Codex parses the
 * markdown; this keeps the same visible text for ordinary prompts.
 */
const markdownText = (text: string): string =>
  text
    .replace(/```[^\n]*\n?/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/gmu, "")
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/gu, "$2");

/**
 * The placeholder title shown while a title is generated, and kept when
 * generation fails: the first message on one line, at most 60 characters,
 * ending with `…` when cut. None for a message with no words.
 */
export const fallbackTitle = (message: string): Option.Option<string> => {
  const excerpt = Array.from(message.trim()).slice(0, FALLBACK_INPUT_MAX_CHARS).join("");
  const title = collapseWhitespace(markdownText(excerpt));
  const characters = Array.from(title);
  if (characters.length === 0) return Option.none();
  if (characters.length <= FALLBACK_MAX_CHARS) return Option.some(title);
  return Option.some(`${characters.slice(0, FALLBACK_MAX_CHARS - 1).join("").trimEnd()}…`);
};

/** The request for a title from the session's first message. */
export const firstPromptTitleRequest = (userMessage: string): string => {
  const prefix = `${TITLE_INSTRUCTIONS}\n\nUser prompt:\n`;
  return prefix + takeBytes(userMessage.trim(), TITLE_PROMPT_MAX_BYTES - byteLength(prefix));
};

/** One message of the conversation `/retitle` names. */
export interface ConversationMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** `text` safe to place inside the `<message>` markup. */
const escapeMarkup = (text: string): string =>
  text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** The instructions for a title from recent messages. */
const conversationPrefix =
  `${TITLE_INSTRUCTIONS}\nPrioritize the current task and latest substantive user request.\n\n` +
  "Recent conversation messages:\n";

/**
 * The request for a title from the latest messages, oldest first. Each
 * message is cut to an equal share of the byte budget when they do not all
 * fit. None when no message has text.
 */
export const conversationTitleRequest = (
  messages: ReadonlyArray<ConversationMessage>,
): Option.Option<string> => {
  const recent = messages
    .filter((message) => message.text.trim().length > 0)
    .slice(-TITLE_RECENT_MESSAGES)
    .map((message) => ({ role: message.role, text: escapeMarkup(message.text.trim()) }));
  if (recent.length === 0) return Option.none();

  const budget = CONVERSATION_PROMPT_MAX_BYTES - byteLength(conversationPrefix);
  const markup =
    byteLength("<conversation>\n\n</conversation>") +
    (recent.length - 1) +
    recent.reduce(
      (sum, message) => sum + byteLength(`<message role=""></message>`) + message.role.length,
      0,
    );
  const content = recent.reduce((sum, message) => sum + byteLength(message.text), 0);
  const share = Math.floor(Math.max(budget - markup, 0) / recent.length);
  const body = recent
    .map((message) => {
      const text =
        content > budget - markup && byteLength(message.text) > share
          ? // Never leave half an `&amp;` behind.
            takeBytes(message.text, share).replace(/&[a-z]*$/u, "")
          : message.text;
      return `<message role="${message.role}">${text}</message>`;
    })
    .join("\n");
  const conversation = `<conversation>\n${body}\n</conversation>`;
  return Option.some(conversationPrefix + takeLastBytes(conversation, budget));
};

/** The answer the instructions ask for. */
const GeneratedTitle = Schema.fromJsonString(Schema.Struct({ title: Schema.String }));
const decodeGeneratedTitle = Schema.decodeUnknownOption(GeneratedTitle);

/** Quotes Codex strips from either end of a title. */
const QUOTES = /^["'`“”‘’]+|["'`“”‘’]+$/gu;

/** A title cleaned the way Codex cleans one; None when nothing is left. */
const normalizeTitle = (title: string): Option.Option<string> => {
  const normalized = collapseWhitespace(title.trim().replace(QUOTES, ""))
    .replace(/[.?!]+$/u, "")
    .trimEnd();
  if (normalized.length === 0) return Option.none();
  return Option.some(Array.from(normalized).slice(0, TITLE_MAX_CHARS).join(""));
};

/**
 * The title in a model's answer. The answer should be `{"title": "..."}`;
 * a code fence around it is accepted, and so is a bare single line, because
 * not every provider can be held to a JSON schema.
 */
export const parseGeneratedTitle = (answer: string): Option.Option<string> => {
  const unfenced = answer
    .trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "")
    .trim();
  if (unfenced.startsWith("{")) {
    return decodeGeneratedTitle(unfenced).pipe(Option.flatMap(({ title }) => normalizeTitle(title)));
  }
  const lines = unfenced.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  return lines.length === 1 ? normalizeTitle(lines[0] ?? "") : Option.none();
};
