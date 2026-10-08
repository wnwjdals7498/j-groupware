# Internal provisioning adapters

These modules implement file preparation, installer ports, scoped console
desired/status transport and product adapters. Customer systemd host activation
and complete installation acceptance remain unexecuted.

`BootstrapFiles` validates the tenant, exact HTTPS origins, currently valid CA,
fixed service names and archive SHA256 before sealing credentials in external
mode-600 files. It stages archives without extracting or executing them, refuses
credential reissuance, and does not install operating-system trust.

`PostgresServiceDatabase` requires an explicitly supplied dedicated postgres
administrator. Preparing the base revokes PUBLIC access to postgres/template1.
Each fixed service database has a nonsuperuser owner and an ownership marker for
this tenant. Existing unmarked objects are refused. Repeated installation checks
the existing credentials instead of rotating them. Backup uses custom pg_dump
and a private PGPASSFILE, never secret argv. Removal sets NOLOGIN, ends that
role's sessions and preserves the database and backup. Reinstallation of removed
data fails for review; automatic purging is not implemented.

`ServiceLifecycle` durably records each stage, preserves generated env secrets
across retries, requires notification registration for approval/talk/mail, and
publishes the gateway only after readiness. Removal stops the service, dumps
once, disables the DB role, runs service cleanup, updates the gateway, then
removes env. Failed stages retain env, backup and recovery state.

`NativeSystemdPlatform` renders fixed entrypoints, dedicated nologin users and
private env files. Root-owned bundle ancestry and metadata digest are checked.
Only j-web permits privilege elevation for its fixed sudo helper. Readiness is
a required product adapter. These operating-system methods were not run on the
cloud host and are not customer VM acceptance.

Cloud verification: actual PostgreSQL 18.6 creates two isolated databases,
denies cross-DB access with valid credentials/code 42501, restores committed
dump bytes, and proves NOLOGIN/session termination while preserving another DB.
Four preparation tests cover secret files, digests, injection/symlink refusal,
failure ordering and read-only systemd unit syntax. Lifecycle ordering uses
explicit test ports, not fake claims of installed services.

`ProductEnvironment` renders exact env names consumed by the compiled approval,
Messenger, Talk, Mail and Web config loaders. It fixes each DB/role, loopback
ports, tenant and TLS paths, retains private notification keys, and generates
an independent Messenger cursor signing key. Existing env must exactly match
the trusted profile; unknown variables, duplicate overrides or profile drift
are refused rather than silently changing persisted credentials.

`ProductReadiness` verifies HTTPS on fixed loopback ports with explicit CA,
bounded JSON, timeout and the actual product response shape. `ServiceInventory`
requires both durable active state and a successful probe for `installed`.
Failed/in-progress/unready allocations remain `incomplete`; reconciliation
repairs desired partial installs and removes undesired partial allocations.
The console preserves this distinction and refuses contradictory or falsely
synchronized reports. Customer-auth DB has no compiled product adapter yet;
an active record for that product fails closed instead of inventing readiness.

`ProductGateway` derives published optional services from durable active state
and the current lifecycle action. It uses the existing actual-worker Nginx
activation/rollback path and leaves j-web-owned configuration intact. Privileged
native commands use a fixed minimal environment, without inherited loader hooks.

Executed Node 22.18/24.19 coverage: preparation/reconciliation 20 each, five
product tests each (including real compiled Talk/Web with their isolated PGs),
15 actual Nginx tests each, whole BFF regression 146 on Node24 and root check
76. Customer VM, notification registration, product storage/cleanup and timer
activation remain separate unexecuted work. Product tests require the external
isolated Talk/Web/auth env files and their built artifacts; they never skip a
missing prerequisite or access port 3001.

Run `JGW_AGENT_TEST_RUNTIME=isolated-cloud npm run test:agent` and
`npm run test:agent:database`. The database test needs Docker, unused loopback
55056 and pg_dump/pg_restore in `/workspace/.cloud-setup/pg18/bin`. On this
sandbox set TMPDIR to an external private directory owned by the running user;
the sandbox's uid-65534 shared /tmp is deliberately rejected by private-file
guards. No port 3001 is used. Fixtures remove only their own random container.
