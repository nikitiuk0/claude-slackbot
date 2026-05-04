## Phase B Smoke Test

Pre-flight:
- [ ] Server container running (Cloud Run or `docker run`).
- [ ] Postgres reachable, migrations applied.
- [ ] Slack app installed in test workspace, bot invited to test channel.

1. Trigger install from unpaired user (@mention in channel):
   - [ ] 🛠️ reaction appears.
   - [ ] "Check your DMs" reply appears in thread.
   - [ ] DM arrives with the `npx pair` command + README link.

2. Run `npx ... pair` on laptop:
   - [ ] Command succeeds; prints machine_id.
   - [ ] `~/.claude-slackbot/profiles/default/` exists with keypair at 0600.
   - [ ] Server logs "machine registered".

3. `npx ... start`:
   - [ ] WS opens; `server_hello` verified.
   - [ ] Re-mention bot from earlier channel — routes to laptop.
   - [ ] Milestones stream in Slack.
   - [ ] Summary posted, ✅ reaction.

4. Re-pair: trigger install again from same user.
   - [ ] Server DMs new code.
   - [ ] `pair` succeeds; DM says previous machines revoked.
   - [ ] Old profile's daemon disconnects with code 4404.

5. Migration broadcast:
   - [ ] Operator invokes `/ops/migrate` (or `tsx src/ops/migrate-broadcast.ts`).
   - [ ] Daemon reconnects to new URL; config.json updated.

6. Auto-update:
   - [ ] Bump version in client/package.json; `npm publish`.
   - [ ] Within 5 min, server logs `update_available broadcast`.
   - [ ] Daemon runs `npm install`, exits, auto-restarts on new version.
