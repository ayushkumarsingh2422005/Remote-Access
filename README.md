# SS Remote

Lightweight remote desktop for personal use between two computers. One machine **shares** its screen; the other **views and controls** it.

No accounts. No VPS required for internet use — `ss start all` opens a free public tunnel automatically (see [setup.md](./setup.md)).

## Quick links

- **Full install & India↔US guide:** [setup.md](./setup.md)
- Config lives at `~/.ss-remote/config.json`

## Install (both PCs)

```bash
npm install
npm link --workspace=ss
ss config set pairCode our-secret-2026
```

## Over the internet (no VPS)

**Host** (PC being controlled):

```bash
ss start all
```

Copy the printed line and send it to your friend:

```text
ss connect wss://….loca.lt
```

**Controller** (you):

```bash
ss connect wss://….loca.lt
```
Stop on the host: `ss stop all`

## Commands

```
ss start all     Relay + internet tunnel + silent agent
ss stop all      Stop everything
ss share         Show the public link again
ss logs          Follow live agent/relay logs (Ctrl+C to stop)
ss connect <url> Controller: save URL and open viewer
ss viewer        Open viewer only
ss status        Running state
ss config        View / set options
```

## Roles

| Role | Machine | Command |
|------|---------|---------|
| Host | Shares screen | `ss start all` |
| Controller | Views + controls | `ss connect <url>` |

## Notes

- Agent runs hidden after `ss start all`
- Capture starts when a controller connects
- Intended for two trusted people only — protect your pair code and tunnel link
