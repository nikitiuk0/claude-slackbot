export type RpcMethod =
  | "postReply"
  | "editMessage"
  | "deleteMessage"
  | "addReaction"
  | "removeReaction"
  | "permalink"
  | "getThread"
  | "downloadFile";

export type RpcArgs = {
  slackClient: {
    chat: {
      postMessage: (args: any) => Promise<any>;
      update: (args: any) => Promise<any>;
      delete: (args: any) => Promise<any>;
      getPermalink: (args: any) => Promise<any>;
    };
    reactions: {
      add: (args: any) => Promise<any>;
      remove: (args: any) => Promise<any>;
    };
    conversations: { replies: (args: any) => Promise<any> };
    users: { info: (args: any) => Promise<any> };
    files: { info?: (args: any) => Promise<any> };
  };
  botToken: string;
  method: RpcMethod;
  params: Record<string, any>;
};

function swallow(codes: string[], err: any): boolean {
  const code = err?.data?.error;
  return typeof code === "string" && codes.includes(code);
}

export async function handleRpcRequest(args: RpcArgs): Promise<any> {
  const { slackClient: c, method, params, botToken } = args;
  switch (method) {
    case "postReply": {
      const r = await c.chat.postMessage({
        channel: params.channel, thread_ts: params.thread_ts, text: params.text,
      });
      return { ts: String(r.ts) };
    }
    case "editMessage": {
      await c.chat.update({ channel: params.channel, ts: params.ts, text: params.text });
      return {};
    }
    case "deleteMessage": {
      try {
        await c.chat.delete({ channel: params.channel, ts: params.ts });
      } catch (err: any) {
        if (!swallow(["message_not_found"], err)) throw err;
      }
      return {};
    }
    case "addReaction": {
      try {
        await c.reactions.add({ channel: params.channel, timestamp: params.ts, name: params.name });
      } catch (err: any) {
        if (!swallow(["already_reacted", "invalid_name"], err)) throw err;
      }
      return {};
    }
    case "removeReaction": {
      try {
        await c.reactions.remove({ channel: params.channel, timestamp: params.ts, name: params.name });
      } catch (err: any) {
        if (!swallow(["no_reaction", "invalid_name"], err)) throw err;
      }
      return {};
    }
    case "permalink": {
      const r = await c.chat.getPermalink({ channel: params.channel, message_ts: params.ts });
      return { url: String(r.permalink) };
    }
    case "getThread": {
      const res = await c.conversations.replies({
        channel: params.channel, ts: params.thread_ts, inclusive: true, limit: 200,
      });
      const messages = (res.messages ?? []) as any[];
      const userIds = Array.from(new Set(messages.map((m) => m.user).filter(Boolean)));
      const displayNames: Record<string, string> = {};
      for (const uid of userIds) {
        try {
          const info = await c.users.info({ user: uid });
          displayNames[uid] =
            info.user?.profile?.display_name?.trim() || info.user?.real_name || uid;
        } catch {
          displayNames[uid] = uid as string;
        }
      }
      return { raw: messages, displayNames };
    }
    case "downloadFile": {
      const fileId = params.file_id as string;
      let url: string | undefined;
      if (c.files?.info) {
        const info = await c.files.info({ file: fileId });
        url = info?.file?.url_private;
      }
      if (!url) throw new Error(`downloadFile: no url_private for file ${fileId}`);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` }, redirect: "manual" });
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok || res.status >= 300) {
        throw new Error(`downloadFile: slack returned status=${res.status}`);
      }
      if (!ct.startsWith("image/") && !ct.startsWith("application/octet-stream")) {
        throw new Error(`downloadFile: unexpected content-type=${ct}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { data_base64: buf.toString("base64"), content_type: ct };
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}
