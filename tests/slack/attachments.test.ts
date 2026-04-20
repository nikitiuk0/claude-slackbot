import { describe, it, expect } from "vitest";
import { renderAttachmentLines, type Attachment } from "../../src/slack/attachments.js";

describe("renderAttachmentLines", () => {
  it("includes local path for downloaded images and slack link for non-downloaded files", () => {
    const atts: Attachment[] = [
      {
        file: {
          id: "F1",
          name: "screenshot.png",
          mimetype: "image/png",
          size: 234567,
          permalink: "https://ws.slack.com/files/U1/F1/screenshot.png",
        },
        localPath: "/abs/data/attachments/T1/F1-screenshot.png",
      },
      {
        file: {
          id: "F2",
          name: "notes.pdf",
          mimetype: "application/pdf",
          size: 500,
          permalink: "https://ws.slack.com/files/U1/F2/notes.pdf",
        },
      },
    ];
    const lines = renderAttachmentLines(atts, "Alice", "14:02");
    expect(lines[0]).toContain("[Alice 14:02 attachment] screenshot.png");
    expect(lines[0]).toContain("image/png");
    expect(lines[0]).toContain("local path: /abs/data/attachments/T1/F1-screenshot.png");
    expect(lines[0]).toContain("slack link: https://ws.slack.com/files/U1/F1/screenshot.png");

    expect(lines[1]).toContain("[Alice 14:02 attachment] notes.pdf");
    expect(lines[1]).toContain("application/pdf");
    // No local path for non-image.
    expect(lines[1]).not.toContain("local path:");
    expect(lines[1]).toContain("slack link: https://ws.slack.com/files/U1/F2/notes.pdf");
  });

  it("handles missing metadata gracefully", () => {
    const atts: Attachment[] = [
      { file: { id: "F3" } },
    ];
    const lines = renderAttachmentLines(atts, "Bob", "09:30");
    expect(lines[0]).toBe("[Bob 09:30 attachment] F3");
  });
});
