import assert from "node:assert/strict";
import { test } from "node:test";
import { Option } from "effect";
import {
  CONVERSATION_PROMPT_MAX_BYTES,
  conversationTitleRequest,
  fallbackTitle,
  firstPromptTitleRequest,
  parseGeneratedTitle,
  TITLE_PROMPT_MAX_BYTES,
} from "../src/title-text.ts";

const bytes = (text: string) => new TextEncoder().encode(text).length;

test("the placeholder is the first message on one line, without markdown", () => {
  assert.deepEqual(
    fallbackTitle("  ## Fix the **login** redirect\n\nin `auth.ts`  "),
    Option.some("Fix the login redirect in auth.ts"),
  );
});

test("a long placeholder is cut to 60 characters with an ellipsis", () => {
  const title = Option.getOrThrow(fallbackTitle("word ".repeat(40)));
  assert.equal(Array.from(title).length, 60);
  assert.ok(title.endsWith("…"));
});

test("a message without words has no placeholder", () => {
  assert.deepEqual(fallbackTitle("   \n  "), Option.none());
});

test("the first-message request stays within Codex's byte budget without splitting characters", () => {
  const request = firstPromptTitleRequest("é".repeat(2_000));
  assert.ok(bytes(request) <= TITLE_PROMPT_MAX_BYTES);
  assert.ok(!request.includes("\uFFFD"));
  assert.ok(request.includes("User prompt:\n"));
});

test("titles are normalized the way Codex normalizes them", () => {
  assert.deepEqual(parseGeneratedTitle('{"title": "  \\"Fix login   redirect.\\" "}'), Option.some("Fix login redirect"));
  assert.deepEqual(
    parseGeneratedTitle('```json\n{"title": "Add OAuth to the settings page?!"}\n```'),
    Option.some("Add OAuth to the settings page"),
  );
  assert.equal(
    Option.getOrThrow(parseGeneratedTitle(`{"title": "${"x".repeat(80)}"}`)).length,
    36,
  );
});

test("a bare single line is accepted, prose and bad JSON are not", () => {
  assert.deepEqual(parseGeneratedTitle("Refactor auth module"), Option.some("Refactor auth module"));
  assert.deepEqual(parseGeneratedTitle("Sure!\nHere is a title: Fix it"), Option.none());
  assert.deepEqual(parseGeneratedTitle('{"name": "Fix it"}'), Option.none());
  assert.deepEqual(parseGeneratedTitle('{"title": "  ...  "}'), Option.none());
});

test("the conversation request keeps the latest eight messages, escaped, within budget", () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `message ${index} <b>&</b> ${"long ".repeat(100)}`,
  }));
  const request = Option.getOrThrow(conversationTitleRequest(messages));
  assert.ok(bytes(request) <= CONVERSATION_PROMPT_MAX_BYTES);
  assert.ok(!request.includes("message 3 "));
  assert.ok(request.includes("message 4 &lt;b&gt;&amp;&lt;/b&gt;"));
  assert.ok(request.includes("message 11 "));
  assert.ok(request.includes("Prioritize the current task"));
});

test("a conversation with no text has nothing to name", () => {
  assert.deepEqual(conversationTitleRequest([{ role: "user", text: "  " }]), Option.none());
});
