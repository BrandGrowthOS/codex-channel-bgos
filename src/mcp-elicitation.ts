import type { RpcObject } from "./app-server.js";
import type { Interactions, InteractionContext } from "./interactions.js";
import { z } from "zod";

const formats: Record<string, z.ZodType> = {
  email: z.email(),
  uri: z.url(),
  date: z.iso.date(),
  "date-time": z.iso.datetime({ offset: true }),
};

async function selectMany(
  interactions: Interactions,
  context: InteractionContext,
  schema: RpcObject,
  title: string,
): Promise<string[] | undefined> {
  const choices: string[] =
    schema.items.enum ?? schema.items.anyOf.map((s: RpcObject) => s.const);
  const selected = new Set<string>();
  let page = 0;
  let error = "";
  while (!context.signal.aborted) {
    const pageOptions = choices
      .slice(page * 4, page * 4 + 4)
      .map((value, i) => ({
        label: `${selected.has(value) ? "✓ " : ""}${schema.items.anyOf?.[page * 4 + i]?.title ?? value}`,
        value: `choice:${page * 4 + i}`,
      }));
    if (choices.length > 4)
      pageOptions.push({ label: "More choices", value: "more" });
    pageOptions.push({
      label: `Done · ${selected.size} selected`,
      value: "done",
    });
    const [answer] = await interactions.ask(context, [
      {
        text: `${title}\nChoose items, then Done.${error ? `\n${error}` : ""}`,
        options: pageOptions,
        allow_free_text: false,
        allow_skip: true,
      },
    ]);
    if (context.signal.aborted || answer.timed_out || answer.skipped)
      return undefined;
    const value = answer.picked_option_value;
    if (value === "more") {
      page = (page + 1) % Math.ceil(choices.length / 4);
      continue;
    }
    if (value === "done") {
      if (
        selected.size < (schema.minItems ?? 0) ||
        selected.size > (schema.maxItems ?? choices.length)
      ) {
        error = `Select ${schema.minItems ?? 0}–${schema.maxItems ?? choices.length} items.`;
        continue;
      }
      return [...selected];
    }
    const at = /^choice:(\d+)$/.exec(value ?? "");
    if (!at || Number(at[1]) >= choices.length) return undefined;
    const choice = choices[Number(at[1])];
    if (selected.has(choice)) selected.delete(choice);
    else selected.add(choice);
    error = "";
  }
  return undefined;
}

/** MCP forms reuse HOAI's identity-bound question cards. */
export async function answerElicitation(
  interactions: Interactions,
  context: InteractionContext,
  params: RpcObject,
): Promise<RpcObject> {
  const cancel = { action: "cancel", content: null, _meta: null };
  if (!["form", "openai/form", "openaiForm"].includes(params.mode))
    return cancel;
  const schema = params.requestedSchema;
  if (
    schema?.type !== "object" ||
    !schema.properties ||
    Array.isArray(schema.properties)
  )
    return cancel;
  const fields = Object.entries(schema.properties) as Array<
    [string, RpcObject]
  >;
  if (!fields.length || fields.length > 20) return cancel;
  // Authentication and secret entry belong on the provider's trusted surface.
  if (
    fields.some(
      ([key, s]) =>
        !s ||
        /password|secret|token|credential|otp|verification.?code/i.test(
          `${key} ${s.title ?? ""}`,
        ) ||
        s.writeOnly ||
        s.format === "password" ||
        (s.format && !formats[s.format]) ||
        s.pattern ||
        !["string", "boolean", "number", "integer", "array"].includes(s.type) ||
        (s.type === "array" &&
          (!s.items ||
            !(Array.isArray(s.items.enum) || Array.isArray(s.items.anyOf)) ||
            !(
              s.items.enum ?? s.items.anyOf.map((v: RpcObject) => v.const)
            ).every((v: unknown) => typeof v === "string"))),
    )
  )
    return cancel;
  const content: Record<string, unknown> = {};
  for (const [key, s] of fields) {
    context.signal.throwIfAborted();
    const title = `${String(params.serverName ?? "MCP")} · ${String(s.title ?? key)}\n${String(s.description ?? params.message ?? "")}`;
    if (s.type === "array") {
      const result = await selectMany(interactions, context, s, title);
      if (!result) return cancel;
      content[key] = result;
      continue;
    }
    const enums = s.enum ?? s.oneOf?.map((entry: RpcObject) => entry.const);
    const values: unknown[] | undefined =
      s.type === "boolean" ? [true, false] : enums;
    if (values && !Array.isArray(values)) return cancel;
    const options =
      values && values.length <= 6
        ? values.map((value, i) => ({
            label: String(s.oneOf?.[i]?.title ?? s.enumNames?.[i] ?? value),
            value: String(value),
          }))
        : undefined;
    const required = (schema.required ?? []).includes(key);
    let accepted = false;
    let error = "";
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      const [answer] = await interactions.ask(context, [
        {
          text: `${title}${error ? `\n${error}` : ""}`,
          options: options ?? [],
          allow_free_text: !options,
          allow_skip: !required,
        },
      ]);
      if (context.signal.aborted || answer.timed_out) return cancel;
      if (answer.skipped) {
        if (required) return cancel;
        accepted = true;
        continue;
      }
      const raw = answer.free_text ?? answer.picked_option_value ?? "";
      let value: unknown = raw;
      if (s.type === "boolean")
        value = raw === "true" ? true : raw === "false" ? false : undefined;
      if (s.type === "number" || s.type === "integer")
        value = raw.trim() ? Number(raw) : undefined;
      const invalid =
        value === undefined ||
        (values && !values.includes(value)) ||
        (typeof value === "number" &&
          (!Number.isFinite(value) ||
            (s.type === "integer" && !Number.isInteger(value)) ||
            value < (s.minimum ?? -Infinity) ||
            value > (s.maximum ?? Infinity))) ||
        (typeof value === "string" &&
          ((s.format && !formats[s.format].safeParse(value).success) ||
            value.length < (s.minLength ?? 0) ||
            value.length > (s.maxLength ?? 10_000)));
      if (invalid) {
        error = `Enter a valid ${s.type}${values ? `: ${values.join(", ")}` : ""}.`;
        continue;
      }
      content[key] = value;
      accepted = true;
    }
    if (!accepted) return cancel;
  }
  return { action: "accept", content, _meta: null };
}
