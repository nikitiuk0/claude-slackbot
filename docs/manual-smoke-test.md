# Manual Smoke Test

Run this checklist against the Slack Developer Sandbox workspace + a small sandbox repo on your laptop (NOT `Tumblr/flavortown` for the first run). Each item lists what to do and what success looks like.

## Pre-flight

- [ ] `data/state.json` does not exist (or has been moved aside).
- [ ] `claude --version` works in your `workdir`.
- [ ] The bot is invited to the test channel (`/invite @claude-bot`).
- [ ] Daemon is running (`npm run start`) and you see `ready` in the logs.

## 1. New run

In the test channel, post a top-level message that mentions the bot:

> `@claude-bot create a file called HELLO.md with one line of content`

Verify:
- [ ] 🤔 reaction appears on the triggering message within ~1s.
- [ ] A reply "Working on it… (planning)" appears in the thread.
- [ ] The reply edits as Claude makes progress (e.g. "Editing HELLO.md", "Running git status", etc.) — at most 1 edit per ~3s due to coalescing.
- [ ] When done, the reply becomes the structured summary (with PR link if the sandbox repo has a remote and Claude pushed; otherwise a commit reference).
- [ ] Reaction swaps 🤔 → ✅.

## 2. Follow-up in the same thread

In the same thread:

> `@claude-bot also include the date in HELLO.md`

Verify:
- [ ] A new "Working on it…" reply (each turn = its own status message).
- [ ] Same branch updated; new commit pushed.
- [ ] If a PR exists, its diff updates.
- [ ] Final summary reply.
- [ ] ✅ reaction on the new triggering message.

## 3. `stop` mid-run

Trigger something long:

> `@claude-bot run "sleep 60 && echo hi" via the Bash tool, then summarize`

While it's running:

> `@claude-bot stop`

Verify:
- [ ] ⏹ reaction on the `stop` message.
- [ ] "Stopped. Re-mention to resume." reply.
- [ ] `pgrep -f claude` (or equivalent) confirms no claude subprocess remains for this thread.
- [ ] State file shows `status: "stopped"` for this thread.

## 4. `nudge` after a stall

Trigger something that loops or hangs:

> `@claude-bot run an infinite loop in Bash and report when done`

Wait until you see the soft "No progress in 5m" notice (you can shortcut by triggering something with a long sleep). Then:

> `@claude-bot nudge`

Verify:
- [ ] Subprocess restarts (you'll see a new "Working on it…" sequence).
- [ ] Claude's next turn references reassessing / picking a different approach (because the synthetic wake-up turn was injected).

## 5. `reset`

In a thread that has prior session state:

> `@claude-bot reset`

Verify:
- [ ] 🧹 reaction on the `reset` message.
- [ ] "Session reset. Next mention will start fresh." reply.
- [ ] State file no longer has an entry for this thread.
- [ ] The next mention starts a brand-new Claude with no memory of prior turns.

## 6. `status`

In any thread (with or without prior state):

> `@claude-bot status`

Verify:
- [ ] Reply with status / start time / last event time / truncated session id.
- [ ] If no state for this thread: "No state for this thread yet."

## 7. Identity rejection

Log in to Slack as a non-allowlisted user (or get a teammate to mention the bot from the same channel). Have them post:

> `@claude-bot fix it`

Verify:
- [ ] 🚫 reaction on their message.
- [ ] A reply: "Sorry, this bot is wired to <ownerDisplayName>'s laptop and won't respond to others. (Multi-user is on the roadmap.)"
- [ ] If they mention the bot AGAIN within 1 hour, no second reply (silent drop).
- [ ] After 1 hour, a fresh mention triggers the rejection reply again.

## 8. Daemon restart mid-run

Trigger a long run (`@claude-bot ...`). Once the bot is mid-work, kill the daemon (Ctrl-C in the terminal). Wait until the daemon has fully shut down. Restart it (`npm run start`).

Verify:
- [ ] On startup, the original thread receives "Daemon restarted; that run was interrupted. Re-mention to resume."
- [ ] State file shows `status: "interrupted"` for that thread.
- [ ] Re-mentioning resumes the session (`claude --resume <session_id>`) — Claude has memory of what it was doing before.

## 9. Concurrency cap (optional, harder to set up)

Configure `maxParallelJobs: 2` in `config.json` (smaller than default to make this easier). Trigger 3 long-running mentions across 3 different threads in quick succession.

Verify:
- [ ] First two get 🤔 + "Working on it…" immediately.
- [ ] Third gets ⏳ reaction + a "Queued — N jobs ahead." reply.
- [ ] If any of the running jobs has been stale for >5m, the queued reply lists their permalinks.
- [ ] When a slot frees, the queued mention starts (🤔 + "Working on it…" appear).

## After running through

If anything failed, capture:
- The relevant Slack message permalinks.
- The contents of `data/state.json` at the point of failure.
- The last ~100 lines of `data/logs/daemon.log` (or stdout).

File issues against the spec or implementation as appropriate.
