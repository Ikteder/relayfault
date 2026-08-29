# Dataset note

RelayFault does not train, evaluate, download, or bundle a dataset. Tests generate short HTTP requests in memory and use ephemeral loopback servers. The example scenario and demo payloads are synthetic, deterministic, and license-free.

User request bodies can pass through the proxy and can appear in the upstream service, but RelayFault's event log records metadata only. It does not record request or response bodies. Users remain responsible for avoiding sensitive data in test systems and for protecting any event path they choose.
