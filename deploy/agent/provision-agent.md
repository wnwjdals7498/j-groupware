# Explicit one-shot provision agent

Run the shipped entrypoint only with an existing sealed bootstrap and an
external private control file:

```sh
node deploy/agent/provision-agent.mjs --config /external/agent.json --once
```

The mode-600 JSON control contains exactly `bootstrapRoot`, `installer`,
`lockRoot`, `productProfileFile` and `stateRoot`, each an absolute external path.
The separate private product profile contains `databasePort`, `profiles` and
optionally `notificationOrigin`, using the existing `ProductEnvironment`
contract. Tenant, console origin, agent key, Keycloak origin and pinned CA come
from the sealed bootstrap; the control cannot override them. Importing or
constructing the runtime executes no installer and registers no timer.

One explicit run holds the tenant lock, reads actual desired services, invokes
the fixed install/remove argv, observes durable state plus TLS readiness, and
reports the observed result to the console. Exit zero requires both synchronized
state and an accepted report. Busy, failed, unconfirmed and rejected reports
exit nonzero. Output contains the safe reconciliation result, never credentials.
SIGINT/SIGTERM abort the run. The configured native installer remains an
external prerequisite; this entrypoint does not grant privileges or install
systemd units, accounts, OS trust or timers.

The console integration fixture passes 18 tests on Node 22.18 and 24.19,
including actual CLI execution with sealed credentials, pinned TLS, real
console/PostgreSQL/Talk processes, lock exclusion, retries and stopped-service
observation. Its private installer records fixed argv and writes owned fixture
state; it is not customer OS installation acceptance. A wrong CA fails the
postcondition and retains incomplete state instead of claiming success.
