# AppPort capability: memos.reactions.list@1

Added by the AppWorks workspace from a verified extraction. Every file here except this README is, byte for byte, a file
the extraction verified against a real Memos at this repository's revision:

| File | What it is |
|---|---|
| `contract.json` | the canonical contract `org.appworks.contracts.memos`, capability `memos.reactions.list@1`, adopted for this integration |
| `runtime/adapter.mjs` | the capability: Memos' own `GET /api/{parent}/reactions`, called with the caller's own credential |
| `runtime/fulfillment.json` | the fulfillment claim the host publishes: this provider capability claims the contract above |
| `runtime/declaration.mjs` | checks the claim against the contract before publishing, and against the published manifest after; fails closed |
| `runtime/host.mjs` | starts the existing bridge (unmodified) with this capability and its claim added |

Run it beside, or instead of, the bridge's own entry point:

```sh
MEMOS_REPO=$PWD APPPORT_BRIDGE_UPSTREAM=http://127.0.0.1:5230 node appport-bridge/appworks/memos-reactions/runtime/host.mjs
```

The host needs `@appport/protocol` 1.2.0 (fulfillment claims) and `@appport/sdk` 1.2.2. The bridge's lockfile pins
`@appport/protocol` 1.1.0 at the time of this change, so the bridge's dependencies must be updated before this host runs
from this repository; the change that adds these files does not touch them.

Nothing here grants access. Every call is authenticated by the bridge, authorized by AppPort (`memos.read`) and decided by
Memos with the caller's own credential. The claim is a declaration about the interface, not authority. The extraction,
its evidence and the promotion that added these files are recorded in the AppWorks workspace that produced this change.
