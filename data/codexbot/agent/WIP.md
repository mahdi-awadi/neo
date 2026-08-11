# WIP

Context before Neo engine reload:

- Attached SQLite file inspected: `inbox/main__1_.db`.
- It matches `/home/z/main.db` byte-for-byte.
- Final project archive copied into this workspace:
  - `outbox/maran-qaleh-ALL-FINAL.zip`
  - source: `/home/z/maran-qaleh-ALL-FINAL.zip`
  - sha256: `a9bb44beadbf5e66535e5e994d823b30644492ceabd0d97fe2559ac285b64ca8`
- Persian presentation notes for the charts were prepared:
  - `outbox/chart-presentation-notes-fa.md`
- Transport note:
  - In this SDK mode, do not call Telegram/channel APIs directly.
  - Do not rely on Neo's in-process MCP `send_file` tool being callable.
  - When the operator asks to send/attach a file, create it inside `agent` and reply with the exact project-relative or absolute path. Neo watches the chat and owns delivery.

Resume task:

- If the operator still wants Telegram delivery, reply with this exact file path so Neo can deliver it:
  - `/home/neo/data/codexbot/agent/outbox/chart-presentation-notes-fa.md`
