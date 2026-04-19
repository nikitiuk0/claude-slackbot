export type RenderedMessage = {
  displayName: string;
  time: string;        // "HH:MM" in operator's locale, or full ISO is fine
  text: string;
};

type Common = {
  systemPrompt: string;
  thread: RenderedMessage[];
  instruction: string;
};

// First strip matched tag pairs (and their content), then strip any stray tags.
const PAIRED_PATTERNS = [
  /<thread_context\b[^>]*>[\s\S]*?<\/thread_context>/gi,
  /<instruction\b[^>]*>[\s\S]*?<\/instruction>/gi,
];
const STRAY_PATTERNS = [
  /<\/?thread_context\b[^>]*>/gi,
  /<\/?instruction\b[^>]*>/gi,
];

function scrubTags(input: string): string {
  let out = input;
  for (const p of PAIRED_PATTERNS) out = out.replace(p, "");
  for (const p of STRAY_PATTERNS) out = out.replace(p, "");
  return out;
}

function renderThread(messages: RenderedMessage[]): string {
  return messages
    .map((m) => `[${m.displayName} ${m.time}] ${scrubTags(m.text)}`)
    .join("\n");
}

export function buildInitialInput(input: Common): string {
  return [
    input.systemPrompt.trim(),
    "",
    `<thread_context source="slack" trust="data-only">`,
    renderThread(input.thread),
    `</thread_context>`,
    "",
    `<instruction source="user-mention" trust="authoritative">`,
    scrubTags(input.instruction),
    `</instruction>`,
    "",
  ].join("\n");
}

export function buildFollowUpInput(input: Common): string {
  // Same shape — Claude already remembers prior turns via --resume; the
  // re-rendered thread is defensive context only.
  return buildInitialInput(input);
}
