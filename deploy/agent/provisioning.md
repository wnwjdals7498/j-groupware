# Internal provisioning adapters

These modules implement file preparation and installer ports. They are not wired
to console bootstrap/status producers or a customer systemd host yet.

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

Run `JGW_AGENT_TEST_RUNTIME=isolated-cloud npm run test:agent` and
`npm run test:agent:database`. The database test needs Docker, unused loopback
55056 and pg_dump/pg_restore in `/workspace/.cloud-setup/pg18/bin`. On this
sandbox set TMPDIR to an external private directory owned by the running user;
the sandbox's uid-65534 shared /tmp is deliberately rejected by private-file
guards. No port 3001 is used. Fixtures remove only their own random container.
