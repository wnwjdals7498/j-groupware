import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { readPreparedBootstrap } from "./base-environment.mjs";
import { readControlJson, readControlFile } from "./control-files.mjs";
import { ProductEnvironment } from "./product-environment.mjs";
import { ProductReadiness } from "./product-readiness.mjs";
import { ServiceLifecycle, ServiceStateFiles } from "./service-lifecycle.mjs";
import {
  PostgresServiceDatabase,
  serviceDatabase,
} from "./service-database.mjs";
import { ServiceEnvironment } from "./service-environment.mjs";
import { NativeSystemdPlatform } from "./native-platform.mjs";
import { ProductGateway } from "./product-gateway.mjs";
import { ProductCleanup } from "./product-cleanup.mjs";
import { ProductStorage, protectedStoragePath } from "./product-storage.mjs";
import { DirectoryLock } from "./reconciler.mjs";
import {
  externalPath,
  loadGatewayProfile,
  execute,
} from "../gateway/gateway.mjs";
import { ProvisionError } from "./provision-error.mjs";
import { BaseBootstrap } from "./base-bootstrap.mjs";

const fail = (code = "invalid_installer_control") => {
  throw new ProvisionError(code);
};
const keys = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
const rootNames = [
  "bundleRoot",
  "environmentRoot",
  "unitRoot",
  "stateRoot",
  "lockRoot",
  "databaseBackupRoot",
  "storageStateRoot",
  "storageBackupRoot",
  "gatewayRoot",
];
const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
export const INSTALLER_CONTROL = "/etc/jgw/provision/control.json";
export function parseProvisionServiceArguments(argv) {
  if (
    !Array.isArray(argv) ||
    ![1, 2].includes(argv.length) ||
    (argv.length === 2 && argv[1] !== "--remove")
  )
    fail("invalid_installer_arguments");
  serviceDatabase(argv[0]);
  if (argv[0] === "j-groupware") fail("invalid_installer_arguments");
  return { service: argv[0], kind: argv.length === 2 ? "remove" : "install" };
}
function bound(service) {
  if (["j-approval", "j-talk", "j-mail"].includes(service))
    fail("notification_operating_owner_unbound");
  if (service === "j-web") fail("web_native_installation_unbound");
  if (!["j-messenger", "j-customer-auth-db"].includes(service))
    fail("invalid_service");
}
// Reads existing sealed configuration only. Unsupported production bindings are
// refused before state, database, OS account, unit or gateway mutation.
export async function loadProvisionServiceControl(file = INSTALLER_CONTROL) {
  if (process.platform !== "linux" || process.getuid() !== 0)
    fail("root_required");
  const input = await readControlJson(file, 32768);
  if (
    !keys(input, [
      "bootstrapRoot",
      "productProfileFile",
      "postgresFile",
      "gatewayProfileFile",
      "roots",
      "storageProfiles",
    ]) ||
    !keys(input.roots, rootNames)
  )
    fail();
  for (const name of [
    "bootstrapRoot",
    "productProfileFile",
    "postgresFile",
    "gatewayProfileFile",
  ])
    externalPath(input[name]);
  for (const value of Object.values(input.roots)) externalPath(value);
  const allRoots = [...Object.values(input.roots), input.bootstrapRoot];
  if (
    new Set(allRoots).size !== allRoots.length ||
    allRoots.some((a, i) =>
      allRoots.some((b, j) => i !== j && b.startsWith(a + "/")),
    )
  )
    fail("overlapping_installer_roots");
  for (const inputFile of [
    file,
    input.productProfileFile,
    input.postgresFile,
    input.gatewayProfileFile,
  ])
    if (
      allRoots.some(
        (root) => inputFile === root || inputFile.startsWith(root + "/"),
      )
    )
      fail("overlapping_installer_roots");
  // This read happens before readPreparedBootstrap's existing-directory guard.
  await readControlFile(input.bootstrapRoot + "/bootstrap.env");
  const bootstrap = await readPreparedBootstrap(input.bootstrapRoot);
  const products = await readControlJson(input.productProfileFile, 16384);
  if (
    !Object.hasOwn(products, "databasePort") ||
    !Object.hasOwn(products, "profiles") ||
    Object.keys(products).some(
      (key) =>
        !["databasePort", "profiles", "notificationOrigin"].includes(key),
    )
  )
    fail("invalid_installer_profile");
  const environment = new ProductEnvironment({
    ...products,
    tenant: bootstrap.tenant,
    keycloakOrigin: bootstrap.keycloakOrigin,
  });
  const postgres = await readControlJson(input.postgresFile, 8192);
  if (
    !keys(postgres, [
      "host",
      "port",
      "database",
      "user",
      "password",
      "passFile",
    ]) ||
    postgres.host !== "127.0.0.1" ||
    postgres.port !== environment.databasePort ||
    postgres.database !== "postgres" ||
    postgres.user !== "postgres" ||
    !/^[A-Za-z0-9_-]{43}$/.test(postgres.password)
  )
    fail("invalid_installer_database");
  externalPath(postgres.passFile);
  if (
    allRoots.some(
      (root) =>
        postgres.passFile === root || postgres.passFile.startsWith(root + "/"),
    )
  )
    fail("overlapping_installer_roots");
  if (
    (await readControlFile(postgres.passFile)) !==
    "127.0.0.1:" + postgres.port + ":*:postgres:" + postgres.password + "\n"
  )
    fail("invalid_installer_database");
  const gatewayProfile = await readControlJson(input.gatewayProfileFile, 16384);
  if (gatewayProfile.JGW_TENANT !== bootstrap.tenant)
    fail("invalid_installer_profile");
  const gateway = loadGatewayProfile(gatewayProfile);
  const ports = [
    environment.databasePort,
    gateway.httpPort,
    gateway.httpsPort,
    gateway.bffPort,
    ...Object.values(environment.profiles).map((profile) => profile.port),
  ];
  if (new Set(ports).size !== ports.length) fail("invalid_installer_profile");
  const customer = environment.profiles["j-customer-auth-db"];
  if (
    customer &&
    (gatewayProfile.JCADB_INTERNAL_PORT !== String(customer.port) ||
      gatewayProfile.JCADB_INTERNAL_PROTOCOL !== "https" ||
      gatewayProfile.JGW_GATEWAY_UPSTREAM_CA !== customer.ca)
  )
    fail("invalid_installer_profile");
  if (
    !input.storageProfiles ||
    typeof input.storageProfiles !== "object" ||
    Array.isArray(input.storageProfiles) ||
    Object.keys(input.storageProfiles).some(
      (service) => service !== "j-messenger",
    )
  )
    fail("invalid_installer_profile");
  for (const [service, profile] of Object.entries(input.storageProfiles))
    if (profile?.root !== environment.profile(service).dataRoot)
      fail("invalid_installer_profile");
  if (
    environment.profiles["j-messenger"] &&
    !input.storageProfiles["j-messenger"]
  )
    fail("storage_adapter_unbound");
  return {
    bootstrap,
    environment,
    postgres,
    gatewayProfile,
    roots: input.roots,
    storageProfiles: input.storageProfiles,
  };
}

export function createProvisionServiceRuntime({
  bootstrap,
  environment,
  postgres,
  gatewayProfile,
  roots,
  storageProfiles,
}) {
  if (
    environment?.tenant !== bootstrap?.tenant ||
    gatewayProfile?.JGW_TENANT !== bootstrap.tenant
  )
    fail("invalid_installer_profile");
  const tenant = bootstrap.tenant;
  // Pool construction is inert; connections open only in an explicitly bound run.
  const admin = new Pool({
    host: postgres.host,
    port: postgres.port,
    database: "postgres",
    user: "postgres",
    password: postgres.password,
    max: 1,
    connectionTimeoutMillis: 3000,
    query_timeout: 15000,
  });
  admin.on("error", () => {});
  const state = new ServiceStateFiles(roots.stateRoot, tenant);
  const database = new PostgresServiceDatabase({
    admin,
    tenant,
    connection: () => ({
      host: postgres.host,
      port: postgres.port,
      connectionTimeoutMillis: 3000,
      query_timeout: 15000,
    }),
    dumpBinary: "/usr/lib/postgresql/18/bin/pg_dump",
    dumpEnv: {
      PGHOST: postgres.host,
      PGPORT: String(postgres.port),
      PGUSER: "postgres",
      PGPASSFILE: postgres.passFile,
    },
  });
  const readiness = new ProductReadiness({ environment });
  const platform = new NativeSystemdPlatform({
    bundleRoot: roots.bundleRoot,
    environmentRoot: roots.environmentRoot,
    unitRoot: roots.unitRoot,
    ready: (service) => readiness.probe(service),
  });
  const storage = new ProductStorage({
    tenant,
    stateRoot: roots.storageStateRoot,
    backupRoot: roots.storageBackupRoot,
    profiles: storageProfiles,
    stopped: (service) => platform.stopped(service),
  });
  const cleanup = new ProductCleanup({ messenger: storage });
  const gateway = new ProductGateway({
    root: roots.gatewayRoot,
    profile: gatewayProfile,
    state,
    commands: {
      validate: () =>
        execute(
          "/usr/sbin/nginx",
          ["-t", "-c", roots.gatewayRoot + "/nginx.conf"],
          { env },
        ),
      reload: () =>
        execute(
          "/usr/sbin/nginx",
          ["-s", "reload", "-c", roots.gatewayRoot + "/nginx.conf"],
          { env },
        ),
    },
  });
  const serviceEnvironment = new ServiceEnvironment({
    root: roots.environmentRoot,
    backups: roots.databaseBackupRoot,
    render: (service, value) => environment.render(service, value),
    read: (service, text) => environment.read(service, text),
  });
  const lifecycle = new ServiceLifecycle({
    tenant,
    state,
    lock: new DirectoryLock(roots.lockRoot),
    database,
    platform,
    gateway,
    cleanup,
    environment: serviceEnvironment,
  });
  return {
    createBaseBootstrap(baseEnvironment, bundles) {
      const gatewayConfig = loadGatewayProfile(gatewayProfile);
      const expectedOrigin = `https://gw.${tenant}.jgw.test${gatewayConfig.httpsPort === 443 ? "" : ":" + gatewayConfig.httpsPort}`;
      if (
        baseEnvironment?.bootstrap?.tenant !== tenant ||
        baseEnvironment.databasePort !== environment.databasePort ||
        baseEnvironment.port !== gatewayConfig.bffPort ||
        baseEnvironment.publicOrigin !== expectedOrigin
      )
        fail("invalid_base_configuration");
      const baseReadiness = new ProductReadiness({
        environment: baseEnvironment,
      });
      const basePlatform = new NativeSystemdPlatform({
        bundleRoot: roots.bundleRoot,
        environmentRoot: roots.environmentRoot,
        unitRoot: roots.unitRoot,
        ready: (service) => baseReadiness.probe(service),
      });
      return new BaseBootstrap({
        bootstrap,
        bundles,
        state,
        lock: new DirectoryLock(roots.lockRoot),
        database,
        environment: new ServiceEnvironment({
          root: roots.environmentRoot,
          backups: roots.databaseBackupRoot,
          render: (service, value) => baseEnvironment.render(service, value),
          read: (service, text) => baseEnvironment.read(service, text),
        }),
        platform: basePlatform,
        gateway,
        preflight: async () => {
          for (const binary of [
            "/usr/lib/postgresql/18/bin/pg_dump",
            "/usr/sbin/nginx",
            "/usr/bin/systemctl",
          ])
            await protectedStoragePath(binary, false);
          await protectedStoragePath(roots.bundleRoot, true);
          await protectedStoragePath(roots.unitRoot, true);
        },
      });
    },
    async run(service, kind = "install") {
      bound(service);
      if (!["install", "remove"].includes(kind)) fail("invalid_action");
      environment.profile(service);
      // Fixed root-owned binaries. Database foundation must already be prepared.
      for (const binary of [
        "/usr/lib/postgresql/18/bin/pg_dump",
        "/usr/sbin/nginx",
        "/usr/bin/systemctl",
      ])
        await protectedStoragePath(binary, false);
      return lifecycle.run(service, kind);
    },
    close: () => admin.end(),
  };
}
export async function runProvisionServiceCli(argv = process.argv.slice(2)) {
  const action = parseProvisionServiceArguments(argv);
  if (process.platform !== "linux" || process.getuid() !== 0)
    fail("root_required");
  bound(action.service);
  const runtime = createProvisionServiceRuntime(
    await loadProvisionServiceControl(),
  );
  try {
    const result = await runtime.run(action.service, action.kind);
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    await runtime.close();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runProvisionServiceCli().catch((error) => {
    process.stderr.write(
      (error instanceof ProvisionError ? error.code : "installer_run_failed") +
        "\n",
    );
    process.exitCode = 1;
  });
