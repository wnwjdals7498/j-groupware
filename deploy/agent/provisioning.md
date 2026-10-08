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
`inspect` validates ownership even for absent/role-only allocations. Teardown
skips the dump only when the database is actually absent, revokes a committed
owned role without requiring a DB, and refuses a database appearing after an
absent observation. Foreign allocations are refused before stopping a unit.

`ServiceLifecycle` durably records each stage, preserves generated env secrets
across retries, requires notification registration after actual readiness for approval/talk/mail, and
publishes the gateway only after readiness. Removal stops the service, dumps
once, disables the DB role, runs service cleanup, updates the gateway, then
removes env. Failed stages retain env, backup and recovery state.

`NotificationManifest` stores only per-service SHA256 hashes in a private file.
It binds the existing NotificationProjector to durable installer generation,
reuses unchanged keys/revisions across retry, removes source hashes on teardown
and refreshes authoritative subscription leases. Existing key replacement is
refused; an explicit key rotation workflow remains separate. Actual auth outage
preserves manifest intent, disables projection and retries the same generation.
The lifecycle registers after readiness and removes registration after cleanup.
The [explicit one-shot worker](notification-worker.md) now binds externally
supplied private short-lived access-token files to the actual subscription reader.
Expiry/lookup failures deactivate the projection and preserve manifest intent.
Actual isolated auth/PG/receiver and CLI execution are checked. Production
credential renewal/topology and operating worker/timer activation remain pending;
importing the adapter does not start a control-plane worker.

`WebServiceCleanup` exposes only root-owned fixed `/usr/local/sbin/jweb-helper
remove-all` with bounded JSON stdin/output and a minimal child environment.
The actual isolated root fixture proves account/site route removal, private
backup preservation of manual uploads, unchanged gateway and repeated cleanup.
Its runtime image is Node22.18; both Node22/24 test orchestrators pass two tests.
It refuses non-Web services, non-root execution and unsafe helper ownership.
`ProductCleanup` retains the already-backed-up PostgreSQL data and compiled
bundle for Approval/Talk/customer-auth, whose servers have no separate persistent file store.
Web delegates to the fixed helper; Messenger file storage, Mailpit storage and
their dedicated cleanup adapters currently fail closed. Customer-auth signing
keys and prepared credentials remain preserved; no private material is purged.
Web OS/storage installation remains pending.

`NativeSystemdPlatform` renders fixed entrypoints, dedicated nologin users and
private env files. Root-owned bundle ancestry, metadata/lockfile digest and the
dependency-install completion marker are checked.
`NativeTlsCredentials` stages immutable, root-owned mode-600 certificate/key/CA
files under a mode-700 `<environmentRoot>/<service>.credentials` directory.
It checks the leaf/key match, direct CA signature, validity, exact private-file
ownership and the independent customer-auth RSA signing key. CA private keys,
CA certificates used as leaves and TLS/CA keys reused for guest JWTs are refused.
Existing different or tampered credentials fail for review; automatic rotation
and deletion are not implemented. Source `.env` paths stay root-private.
Units use fixed `LoadCredential` entries. The non-root launcher accepts only its
unit's fixed `/run/credentials/jgw-<service>.service` directory, substitutes the
actual product variable names and removes loader hooks. It calls Linux Node's
[`process.execve`](https://nodejs.org/docs/latest-v22.x/api/process.html#processexecvefile-args-env)
to start a fresh process with `NODE_EXTRA_CA_CERTS` and retain the unit PID.
This API is experimental; the supported Node22.18/24.19 binaries were both
actually exercised. Unit startup removes the original root-only CA variable
before initializing the launcher. Dedicated account UID/GID zero is refused.
The isolated container tests use actual nologin users and private credential
permissions: a service reads its own files but cannot read another service's
files or the root CA key. They construct the systemd credential layout and
prove fresh-process HTTPS CA trust; actual systemd PID1 delivery/activation and
customer account installation remain unexecuted. See the
[customer-auth/TLS report](../../docs/cloud-customer-auth-tls-verification-2026-10-08.md).
Readiness and stop also refuse a unit whose fixed content or ownership differs;
an absent unit is accepted on teardown only after an actual systemctl property
query confirms not-found/inactive with no fragment. Loaded foreign fragments,
changed unit files and unobserved states are refused. The property protocol is
checked against [systemd's source](https://github.com/systemd/systemd/blob/v257/src/systemctl/systemctl-show.c);
actual systemd stop/absent-unit acceptance remains unexecuted on a customer host.
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
Messenger, Talk, Mail, Web and customer-auth config loaders. It fixes each DB/role, loopback
ports, tenant and TLS paths, retains private notification keys, and generates
independent Messenger and customer-auth cursor signing keys. Customer-auth fixes
the tenant HTTPS public origin and independent guest signing key path. Existing env must exactly match
the trusted profile; unknown variables, duplicate overrides or profile drift
are refused rather than silently changing persisted credentials.

`ProductReadiness` verifies HTTPS on fixed loopback ports with explicit CA,
bounded JSON, timeout and the actual product response shape. `ServiceInventory`
requires both durable active state and a successful probe for `installed`.
Failed/in-progress/unready allocations remain `incomplete`; reconciliation
repairs desired partial installs and removes undesired partial allocations.
The console preserves this distinction and refuses contradictory or falsely
synchronized reports. Customer-auth's actual `{ready:true}` HTTPS shape is
verified; missing profiles still fail closed. The latest fixture installs its
cold archive, preserves secrets on retry and observes a stopped active process
as incomplete, without adding duplicate inventory entries.

`ProductGateway` derives published optional services from durable active state
and the current lifecycle action. It uses the existing actual-worker Nginx
activation/rollback path and leaves j-web-owned configuration intact. Privileged
native commands use a fixed minimal environment, without inherited loader hooks.

Earlier Node 22.18/24.19 checkpoint coverage: preparation/reconciliation 20 each, five
product tests each (including real compiled Talk/Web with their isolated PGs),
15 actual Nginx tests each, whole BFF regression 148 each and root check 76. Customer VM, notification worker activation, remaining product storage/cleanup and timer
activation remain separate unexecuted work. Product tests require the external
isolated Talk/Web/auth env files and their built artifacts; they never skip a
missing prerequisite or access port 3001.

The [latest bootstrap/worker report](../../docs/cloud-bootstrap-worker-verification-2026-10-08.md)
records full BFF158, safe unpack19, base cold BFF4, actual PG6 and explicit
notification worker6 on each Node version, plus the unchanged source status and
separate unexecuted customer/OS acceptance. An initial compiled-receiver startup
failure did not recur in the standalone projection/full reruns; its failed log
and unresolved cause are preserved.

The [internal bundle producer](bundles.md) now supplies the fixed metadata,
compiled server/contracts, migrations and product assets required by native
preflight. Five products pass cold dependency installation; actual extracted
Talk/Web boot and widget bytes are tested. This does not install bundles,
helper privileges, units, OS trust or a timer on the cloud/customer host. The
base BFF bundle now includes its four runtime workspaces and deploy adapters.
BundleInstaller performs strict bounded USTAR extraction, digest/inventory/lock
validation, scripts-disabled npm ci and exclusive destination publication.
BaseEnvironment decodes sealed bootstrap files and emits exact BFF variables;
it excludes the console agent key. Actual cold BFF tests run as the existing
isolated cloud user. Dedicated-account CA/TLS source and isolated container
permissions are now verified; actual systemd credential delivery and the
complete bootstrap/installer entrypoint remain pending.

The [customer relay/bundle report](../../docs/cloud-customer-relay-bundle-verification-2026-10-08.md)
adds exact registry contracts consumption, actual customer guest/key BFF relay,
the seventh cold bundle/profile/readiness and real HTTPS Nginx activation and
withdrawal. Full BFF regression passes 174 tests per Node version. This does not
activate customer systemd, timers, accounts or operating CA trust.

Run `JGW_AGENT_TEST_RUNTIME=isolated-cloud npm run test:agent` and
`npm run test:agent:database`. The database test needs Docker, unused loopback
55056 and pg_dump/pg_restore in `/workspace/.cloud-setup/pg18/bin`. On this
sandbox set TMPDIR to an external private directory owned by the running user;
the sandbox's uid-65534 shared /tmp is deliberately rejected by private-file
guards. No port 3001 is used. Fixtures remove only their own random container.
`JGW_AGENT_TEST_RUNTIME=isolated-cloud npm run test:agent:tls` runs the dedicated
service-account credential fixture. It needs the already-built isolated
`jweb-isolated-hosting:20261008` Docker image; it registers no host account or
unit and publishes no host port. Run large Docker/cold fixtures sequentially
when the workspace has limited free disk.
