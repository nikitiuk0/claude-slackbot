/**
 * Convert the most common non-Slack Markdown / HTML patterns in a text
 * block into Slack mrkdwn. This is a minimal post-processor — the primary
 * mechanism is the system prompt instructing Claude to emit Slack mrkdwn
 * directly. This just catches accidental slips so messages aren't visually
 * broken in Slack.
 */
export function toSlackMrkdwn(text: string): string {
  let out = text;

  // <code>…</code> → `…`
  out = out.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");

  // <pre>…</pre> (optionally wrapping <code>) → ```…```
  out = out.replace(/<pre>\s*<code>([\s\S]*?)<\/code>\s*<\/pre>/gi, "```\n$1\n```");
  out = out.replace(/<pre>([\s\S]*?)<\/pre>/gi, "```\n$1\n```");

  // **bold** → *bold*  (be careful not to mangle already-Slack *bold*)
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");

  // __bold__ → *bold* (double-underscore is GFM bold)
  out = out.replace(/__([^_\n]+?)__/g, "*$1*");

  // [label](url) → <url|label>
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>");

  return out;
}
