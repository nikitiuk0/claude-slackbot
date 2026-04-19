import { z } from "zod";

export type ParseEvent =
  | { kind: "session-init"; sessionId: string }
  | { kind: "milestone"; text: string }
  | { kind: "summary"; text: string }
  | { kind: "result"; success: boolean };

const TextItem = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ToolUseItem = z.object({
  type: z.literal("tool_use"),
  name: z.string(),
  input: z.record(z.unknown()).optional(),
});

const ContentItem = z.union([TextItem, ToolUseItem, z.object({}).passthrough()]);

const SystemInit = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
});

const AssistantLine = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(ContentItem) }),
});

const ResultLine = z.object({
  type: z.literal("result"),
  subtype: z.string(),
});

const SUMMARY_RE = /<slack-summary>([\s\S]*?)<\/slack-summary>/;

function toolMilestone(name: string, input: Record<string, unknown> | undefined): string | null {
  const file = input?.file_path as string | undefined;
  const command = input?.command as string | undefined;
  const pattern = input?.pattern as string | undefined;
  switch (name) {
    case "Read":
      return file ? `Reading ${file}` : "Reading a file";
    case "Edit":
    case "Write":
      return file ? `Editing ${file}` : "Editing a file";
    case "Bash":
      return command ? `Running \`${command}\`` : "Running a shell command";
    case "Grep":
      return pattern ? `Searching for ${pattern}` : "Searching";
    case "Glob":
      return pattern ? `Listing files matching ${pattern}` : "Listing files";
    case "WebFetch":
      return `Fetching ${(input?.url as string) ?? "a URL"}`;
    case "Task":
      return "Spawning sub-agent";
    case "TodoWrite":
      return null; // todo updates handled separately if needed
    default:
      return `Using tool: ${name}`;
  }
}

export async function* parseStream(
  lines: AsyncIterable<string>
): AsyncIterable<ParseEvent> {
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }

    const sys = SystemInit.safeParse(json);
    if (sys.success) {
      yield { kind: "session-init", sessionId: sys.data.session_id };
      continue;
    }

    const asst = AssistantLine.safeParse(json);
    if (asst.success) {
      for (const item of asst.data.message.content) {
        const tu = ToolUseItem.safeParse(item);
        if (tu.success) {
          const m = toolMilestone(tu.data.name, tu.data.input);
          if (m) yield { kind: "milestone", text: m };
          continue;
        }
        const t = TextItem.safeParse(item);
        if (t.success) {
          const match = SUMMARY_RE.exec(t.data.text);
          if (match?.[1] !== undefined) {
            yield { kind: "summary", text: match[1].trim() };
          }
        }
      }
      continue;
    }

    const res = ResultLine.safeParse(json);
    if (res.success) {
      yield { kind: "result", success: res.data.subtype === "success" };
      continue;
    }
  }
}
