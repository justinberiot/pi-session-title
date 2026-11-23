import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { startTitleRuntime, type TitleModelAccess } from "../src/title-runtime.ts";

const model = (provider: string, id: string): Model<Api> =>
  ({ provider, id, name: id, api: "openai-responses" }) as Model<Api>;

const answer = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    timestamp: 0,
  }) as AssistantMessage;

/** A title model whose answers the test controls. */
const access = (
  complete: TitleModelAccess["complete"],
  overrides: Partial<TitleModelAccess> = {},
): TitleModelAccess => ({
  currentModel: model("pi-claude-cli", "claude-opus-5-5"),
  settings: {},
  findModel: (provider, id) => (provider === "openai" ? model(provider, id) : undefined),
  hasAuth: () => true,
  complete,
  ...overrides,
});

/** The outcome of one first-message request. */
const nameOnce = (testAccess: TitleModelAccess, userMessage = "fix the login redirect in auth.ts") =>
  new Promise<{ provisional: string[]; saved: string[]; failures: string[] }>((resolve) => {
    const runtime = startTitleRuntime();
    const seen = { provisional: [] as string[], saved: [] as string[], failures: [] as string[] };
    runtime.nameFromFirstPrompt({
      userMessage,
      access: testAccess,
      showProvisional: (title) => seen.provisional.push(title),
      save: (title) => {
        seen.saved.push(title);
        void runtime.dispose().then(() => resolve(seen));
        return true;
      },
      onFailure: (message) => seen.failures.push(message),
    });
  });

test("the first message shows a placeholder, then saves the generated title", async () => {
  const seen = await nameOnce(access(async () => answer('{"title": "Fix login redirect"}')));
  assert.deepEqual(seen.provisional, ["fix the login redirect in auth.ts"]);
  assert.deepEqual(seen.saved, ["Fix login redirect"]);
  assert.deepEqual(seen.failures, []);
});

test("the current model is used unless sessionTitle.model names another", async () => {
  const used: string[] = [];
  const record: TitleModelAccess["complete"] = async (chosen) => {
    used.push(`${chosen.provider}/${chosen.id}`);
    return answer('{"title": "Fix it"}');
  };
  await nameOnce(access(record));
  await nameOnce(access(record, { settings: { sessionTitle: { model: "openai/gpt-6-luna" } } }));
  assert.deepEqual(used, ["pi-claude-cli/claude-opus-5-5", "openai/gpt-6-luna"]);
});

test("a failed request keeps the placeholder as the name and reports why", async () => {
  const seen = await nameOnce(access(async () => answer("", "error")));
  assert.deepEqual(seen.saved, ["fix the login redirect in auth.ts"]);
  assert.equal(seen.failures.length, 1);
  assert.match(seen.failures[0] ?? "", /could not write a session title/u);
});

test("an unknown configured model is reported, not silently replaced", async () => {
  const seen = await nameOnce(
    access(async () => answer('{"title": "Fix it"}'), {
      settings: { sessionTitle: { model: "nowhere/model" } },
    }),
  );
  assert.deepEqual(seen.saved, ["fix the login redirect in auth.ts"]);
  assert.match(seen.failures[0] ?? "", /Pi does not know/u);
});

test("cancelling aborts the model request and saves nothing", async () => {
  const runtime = startTitleRuntime();
  let aborted = false;
  let started: () => void = () => {};
  const requestStarted = new Promise<void>((resolve) => (started = resolve));
  const saved: string[] = [];
  runtime.nameFromFirstPrompt({
    userMessage: "rename me",
    access: access(
      (_model, _prompt, signal) =>
        new Promise<AssistantMessage>((resolve) => {
          started();
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(answer('{"title": "Too late"}'));
          });
        }),
    ),
    showProvisional: () => {},
    save: (title) => {
      saved.push(title);
      return true;
    },
    onFailure: () => assert.fail("a cancelled request is not a failure"),
  });
  await requestStarted;
  runtime.cancel();
  await runtime.dispose();
  assert.equal(aborted, true);
  assert.deepEqual(saved, []);
});

test("/retitle names the session from its latest messages", async () => {
  const runtime = startTitleRuntime();
  let prompt = "";
  const result = await runtime.retitle(
    [
      { role: "user", text: "why are my tabs called shell" },
      { role: "assistant", text: "the window label is hardcoded" },
      { role: "user", text: "now build a pi extension for titles" },
    ],
    access(async (_model, sent) => {
      prompt = sent;
      return answer('{"title": "Build session title extension"}');
    }),
  );
  await runtime.dispose();
  assert.deepEqual(result, { ok: true, title: "Build session title extension" });
  assert.match(prompt, /<message role="user">now build a pi extension for titles<\/message>/u);
});
