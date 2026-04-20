import { promises as fs } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { Logger } from "../log.js";

export type SlackFile = {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  permalink?: string;
};

export type Attachment = {
  file: SlackFile;
  /** Absolute local path if we downloaded it; undefined otherwise. */
  localPath?: string;
};

/** Filesystem-safe slug of a filename. */
function safeName(name: string | undefined, fallback: string): string {
  const base = name ?? fallback;
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

/**
 * Downloads Slack image attachments for a thread to `<baseDir>/<threadTs>/`
 * using the bot's bearer token. Skips non-image files and skips any file
 * already on disk (caching across mentions on the same thread).
 */
export class AttachmentsStore {
  constructor(
    private readonly baseDir: string,
    private readonly botToken: string,
    private readonly log?: Logger
  ) {}

  dirFor(threadTs: string): string {
    const safeThread = threadTs.replace(/[^0-9.]/g, "_");
    return resolvePath(join(this.baseDir, safeThread));
  }

  async downloadImagesForThread(
    threadTs: string,
    files: SlackFile[]
  ): Promise<Attachment[]> {
    const results: Attachment[] = [];
    for (const file of files) {
      if (!file.mimetype?.startsWith("image/")) {
        results.push({ file });
        continue;
      }
      if (!file.url_private) {
        results.push({ file });
        continue;
      }
      const dir = this.dirFor(threadTs);
      const target = join(dir, `${file.id}-${safeName(file.name, file.id)}`);
      try {
        await fs.stat(target);
        // Already downloaded — skip network round-trip.
        results.push({ file, localPath: target });
        continue;
      } catch { /* not there yet */ }

      try {
        await fs.mkdir(dirname(target), { recursive: true });
        const res = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${this.botToken}` },
          redirect: "manual",
        });
        const contentType = res.headers.get("content-type") ?? "";
        // Slack returns a 302 → login page when the bot token lacks
        // `files:read`. Following the redirect would give us HTML; without
        // following it, we see status 302 with a Location pointing to
        // slack.com. Either way, a non-image content-type or a redirect
        // means we shouldn't write to disk.
        if (res.status >= 300 && res.status < 400) {
          this.log?.warn(
            {
              fileId: file.id,
              status: res.status,
              location: res.headers.get("location"),
            },
            "slack returned redirect for file download — bot token likely lacks files:read scope"
          );
          results.push({ file });
          continue;
        }
        if (!res.ok) {
          this.log?.warn(
            { fileId: file.id, status: res.status },
            "slack file download returned non-OK status"
          );
          results.push({ file });
          continue;
        }
        if (!contentType.startsWith("image/") && !contentType.startsWith("application/octet-stream")) {
          this.log?.warn(
            { fileId: file.id, contentType, expected: file.mimetype },
            "slack file download returned wrong content-type (probably sign-in HTML); missing files:read?"
          );
          results.push({ file });
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(target, buf);
        this.log?.info(
          { fileId: file.id, bytes: buf.length, target },
          "downloaded slack attachment"
        );
        results.push({ file, localPath: target });
      } catch (err) {
        this.log?.warn({ err, fileId: file.id }, "slack file download threw");
        results.push({ file });
      }
    }
    return results;
  }

  /** Remove all downloaded attachments for a thread. Best-effort. */
  async purgeThread(threadTs: string): Promise<void> {
    const dir = this.dirFor(threadTs);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function humanSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Turn attachments into text lines that the prompt builder will include
 * inside <thread_context>. Claude sees local paths for downloaded images
 * (can Read them directly) and metadata+permalink for everything else.
 */
export function renderAttachmentLines(
  attachments: Attachment[],
  senderName: string,
  time: string
): string[] {
  return attachments.map((a) => {
    const { file, localPath } = a;
    const name = file.name ?? file.id;
    const meta = [file.mimetype, humanSize(file.size)].filter(Boolean).join(", ");
    const parts = [`[${senderName} ${time} attachment] ${name}${meta ? ` (${meta})` : ""}`];
    if (localPath) parts.push(`  local path: ${localPath}`);
    if (file.permalink) parts.push(`  slack link: ${file.permalink}`);
    return parts.join("\n");
  });
}
