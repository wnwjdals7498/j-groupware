# Customer VM acceptance preparation

`collect.mjs` prepares a safe, read-only evidence report for one explicit service profile. It does not install or change a service and it cannot mark an acceptance feature complete. Every report includes `acceptance_complete: false`, the full `not_run_list`, and profile/evidence provenance. A healthy HTTPS probe is only a preflight signal; user flows, authorization, firewalls, systemd, backups, rollback, and VM resource evidence remain separate acceptance work.

Run with Node 22.18+ or 24 and an operator-provided JSON profile:

```sh
node tools/customer-acceptance/collect.mjs --profile /path/to/customer-profile.json
```

There is no default URL or profile. Without `--profile`, the tool makes no network request and reports all acceptance tests as not run. The only remote operation is an unauthenticated HTTPS `GET` to an explicitly approved hostname and a role-specific safe path. Redirects, URL credentials, query strings, fragments, encoded paths, traversal, unapproved hosts, loopback targets outside a local fixture profile, and port 3001 are rejected. TLS verification is mandatory. Requests time out after 2.5 seconds; response bodies are drained in memory up to 16 KiB and are never parsed, written, or included in reports.

Profile shape:

```json
{
  "version": 1,
  "profileId": "customer-acceptance-01",
  "serviceId": "j-messenger",
  "featureId": "MS-09",
  "execution": { "kind": "customer-vm", "id": "customer-vm-01" },
  "approvedHostnames": ["messenger.example.invalid"],
  "targets": [
    {
      "role": "service-health",
      "url": "https://messenger.example.invalid/health/ready"
    }
  ],
  "configurationEvidence": [],
  "resourceEvidence": [],
  "operationsEvidence": []
}
```

The example uses the reserved `.invalid` domain and is not a runnable target. `serviceId` and `featureId` must match one of the rows below. Each profile must contain all target roles for its feature. Target hostnames must be explicitly listed in `approvedHostnames`.

| Service            | Feature / acceptance test | Read-only target roles and fixed paths                                                                                        | Additional evidence stays not-run unless supplied                                                 |
| ------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| j-auth             | AU-51 / AU-T10            | `oidc-discovery`: `/realms/{realm}/.well-known/openid-configuration`; `jwks`: `/realms/{realm}/protocol/openid-connect/certs` | login flow, management API, backchannel, Nginx allowlist, CPU/memory                              |
| j-groupware        | GW-73 / GW-T19            | `control-health` and `customer-health`: `/health/ready`; separate approved hosts required                                     | both VM identities, gateway/relay, G8, CPU/memory                                                 |
| j-messenger        | MS-09 / MS-T04            | `service-health`: `/health/ready`                                                                                             | two-member flow, sync/reconnect, revocation, internal ports, PG isolation, install/removal/backup |
| j-mail             | ML-32 / ML-T05            | `service-health`: `/health/ready`                                                                                             | Mailpit UI, blocked egress, systemd, volume backup/removal, internal ports                        |
| j-customer-auth-db | CA-32 / CA-T05            | `service-health`: `/health/ready`; `customer-auth-exception`: `/ext/customer-auth/`                                           | screen registration, site login, external query, private internal API, backup/removal             |
| j-approval         | AP-32 / AP-T06            | `service-health`: `/health/ready`                                                                                             | HTTPS/systemd, submit/sequence/history, private internal API, removal                             |
| j-talk             | TK-42 / TK-T06            | `service-health`: `/health/ready`; `talk-exception`: `/ext/talk/`                                                             | widget flow, `/ext` boundary, allowed origin, empty widget after removal, VM baseline             |
| j-web              | WB-33 / WB-T05            | `service-health`: `/health/ready`; `site-root`: `/`                                                                           | site HTTPS, isolated SFTP/sshd, explicit TLS FTPS, widget origin, remove-all/backup               |

Configuration evidence entries may only use the IDs listed in `feature-matrix.mjs`; they contain a status (`observed`, `absent`, or `not_run`), a source kind, and a timestamp. Read-only resource evidence is scoped per VM and requires CPU percent, process RSS, and free disk bytes; O02 service metrics can also include memory/disk totals, DB/WAL bytes, outbox count, request p95, and sample count. Reports retain metric names, scope, source, timestamp, and whether evidence was measured, but omit supplied numeric values. No profile value, path, URL path, response body, credential, token, password, certificate content, or arbitrary error text is copied into the report.

`operationsEvidence` entries use `{ "gateId", "evidenceId", "status", "source", "observedAt" }`; both IDs must be in the fixed O01–O05 matrix. Each report prints the individual evidence rows while every operational gate remains `not_run`.

| Gate | Read-only evidence rows prepared                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------- |
| O01  | mail auth, TLS chain, network allowlist, release ID, rollback compatibility                                     |
| O02  | CPU/RSS/p95, DB/WAL space, disk protection, load fixture, outbox recovery                                       |
| O03  | secret redaction, rotation/reboot retention, read access, audit separation, bounded export                      |
| O04  | DB snapshot consistency, file manifest coverage, retention pruning, last good backup, restoreability            |
| O05  | service block order, DB/file integrity, current policy, session/cursor invalidation, functional resume, RPO/RTO |

An HTTPS response cannot complete mail auth/release/network checks, load/space-protection checks, journal policy/permissions, backup/restore, or session invalidation.

The eight feature-specific IDs and target roles follow the source acceptance specifications: `j-auth/docs/feature-specifications.md` (AU-T10), `j-groupware/docs/feature-specifications.md` (GW-T19), `j-messenger/docs/suite-integration-specifications.md` (MS-T04), and each service's `docs/feature-specifications.md` (ML-T05, CA-T05, AP-T06, TK-T06, WB-T05). O01–O05 remain separate operational gates; this collector is only preparation/evidence collection and performs none of their system-level actions.

Run the local HTTPS fixture suite with either supported runtime:

```sh
node --test tools/customer-acceptance/test/collector.test.mjs
```

The fixture creates a temporary local test certificate and binds an ephemeral loopback port. It exercises trusted TLS, rejected TLS, unreachable targets, wrong profiles, oversized/sensitive responses, and URL rejection. Fixture results always have `acceptance_complete: false` and do not count as VM acceptance.
