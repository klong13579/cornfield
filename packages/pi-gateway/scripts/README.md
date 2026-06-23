# pi-gateway/scripts/

Manual tools for inspecting DingTalk wire format and exercising the channel
parser / bridge pipeline against real or synthetic data.

## `dump-dingtalk-msgtype.ts`

Pushes a **synthetic** `DingTalkRawMessage` for each supported `msgtype`
(text / markdown / picture / audio / video / file / richText) through the
real channel parser, real `SessionManager`, and real `AgentBridge` against
a fake `omp --mode rpc` echo script. Prints the raw JSON, the parsed
content, the prompt the agent sees, and the response.

```bash
cd packages/pi-gateway
bun run scripts/dump-dingtalk-msgtype.ts                 # all 7 types
bun run scripts/dump-dingtalk-msgtype.ts video          # one type
bun run scripts/dump-dingtalk-msgtype.ts --json '{...}' # raw override
```

## `capture-dingtalk.ts`

Connects to the **real** DingTalk Stream SDK using the credentials in
`~/.omp/gateway.json` and appends every incoming `DingTalkRawMessage` to
a JSONL file. Used to:

1. See the actual wire format DingTalk sends (confirm our templates).
2. Get real `downloadCode` values to feed into the replay harness.
3. Verify the `content` JSON shape for picture / audio / video / file /
   richText messages from a live source.

```bash
cd packages/pi-gateway
bun run scripts/capture-dingtalk.ts --account hr
bun run scripts/capture-dingtalk.ts --account hr --out /tmp/cap.jsonl
bun run scripts/capture-dingtalk.ts --account hr --msgtypes picture,video,file
bun run scripts/capture-dingtalk.ts --account hr --timeout 60000
```

While the script is running, send messages from your DingTalk client to
the bot. Each captured message is printed to stdout (pretty JSON) and
appended to the capture file. Use Ctrl-C to stop.

## `replay-dingtalk.ts`

Reads a JSONL capture file (produced by `capture-dingtalk.ts`) and runs
each captured `DingTalkRawMessage` through the real `DingTalkChannel`
parser + a fake `omp --mode rpc` (deterministic echo) so you can verify
how the real DingTalk wire format is parsed and what the agent prompt
looks like.

The real `downloadMedia` (OAPI call) is invoked by default, which DOES
hit the real DingTalk servers with your real credentials. If you do not
want that, use `--fake-download` to substitute a placeholder instead.

```bash
cd packages/pi-gateway
bun run scripts/replay-dingtalk.ts /tmp/dingtalk-capture.jsonl
bun run scripts/replay-dingtalk.ts /tmp/cap.jsonl --only picture,video
bun run scripts/replay-dingtalk.ts /tmp/cap.jsonl --fake-download
bun run scripts/replay-dingtalk.ts /tmp/cap.jsonl --limit 5
```

## Suggested workflow

1. Run `dump-dingtalk-msgtype.ts` to see the parser/bridge pipeline
   behaviour for our synthetic templates.
2. Run `capture-dingtalk.ts --account <id>` in one terminal.
3. From your DingTalk client, send each msgtype (text, picture, audio,
   video, file, richText) to the bot.
4. Run `replay-dingtalk.ts /tmp/dingtalk-capture.jsonl` to compare the
   real wire format with our templates, and to confirm that the parser
   handles real `downloadCode` and real `content` JSON correctly.
