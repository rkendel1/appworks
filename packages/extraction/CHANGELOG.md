# Changelog: @appport/extraction

## 0.1.0

First release. Capability extraction artifacts for read-only request/response operations: eligibility, contract and mapping checks, adapter identity, fulfillment declarations, per-behavior verification records and revision rules (`appport.capability-extraction/2`, reading `/1`), and the `appworks` command (`assess`, `verify`, `extract`, `verify-extraction`).

- Takes a Protocol Buffers RPC candidate. An HTTP route (assessment format `/2`) is refused with `CANDIDATE_NOT_RPC`: this version has no way to derive a contract, an adapter or a behavioral suite for one.
- Depends on `@appport/assessment` 0.1.0, `@appport/protocol` 1.3.0 and `@appport/schema` 1.1.3.
