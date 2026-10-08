import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  readFile,
  mkdtemp,
  rm,
  lstat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { NotificationManifest } from "../../deploy/agent/notification-manifest.mjs";
import { integrationRuntime, type Runtime } from "./runtime.js";
import { NotificationStore } from "../../apps/server/src/db/notifications.js";
import { createNotificationReceiver } from "../../apps/server/src/notification-receiver.js";
import {
  NotificationProjector,
  NotificationProjectionWorker,
  type NotificationKeyManifest,
  type SubscriptionReader,
} from "../../apps/server/src/notification-projection.js";
import { digest } from "../../apps/server/src/security.js";

describe("isolated real j-auth subscription + PostgreSQL notification projection", () => {
  let rt: Runtime;
  const stores: NotificationStore[] = [],
    receivers: ReturnType<typeof createNotificationReceiver>[] = [],
    keys: string[] = [],
    workers: NotificationProjectionWorker[] = [];
  const manifest = (
    index = 0,
    revision = "1",
    key = keys[index]!,
  ): NotificationKeyManifest => ({
    tenantId: rt.fixtures[index]!.tenant,
    revision,
    keys: { "j-mail": { currentHash: digest(key) } },
  });
  const source =
    (index = 0): SubscriptionReader =>
    async (tenant, signal) => {
      if (tenant !== rt.fixtures[index]!.tenant)
        throw new Error("Unknown fixture tenant.");
      return rt.subscriptionSnapshot(index, signal);
    };
  const receive = (index = 0, key = keys[index]!, dedupKey = randomUUID()) =>
    rt.fetchLoopback(
      `http://127.0.0.1:${54256 + index}/internal/notifications`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-JGW-Internal-Key": key,
        },
        body: JSON.stringify({
          tenant: rt.fixtures[index]!.tenant,
          service: "j-mail",
          type: "mail.new",
          usernames: ["recipient"],
          title: "새 메일",
          body: "",
          link: "/mail/messages/fixture-message",
          dedupKey,
        }),
      },
    );
  const identity = {
    subject: "recipient-id",
    username: "recipient",
    roles: ["mail:read"],
  };
  const state = (index = 0) =>
    rt.pool.query(
      "SELECT service,key_hashes,active,projection_expires_at,previous_key_expires_at FROM notification_services WHERE tenant_id=$1 ORDER BY service",
      [rt.fixtures[index]!.tenant],
    );
  const wait = async (check: () => Promise<boolean>, timeout = 6000) => {
    const until = Date.now() + timeout;
    do {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < until);
    throw new Error("Actual projection observation timeout.");
  };
  beforeAll(async () => {
    rt = await integrationRuntime();
    for (const [index, fixture] of rt.fixtures.entries()) {
      expect((await rt.subscribe(index, "j-mail")).status).toBe(200);
      keys.push(randomBytes(32).toString("base64url"));
      rt.secretValues.add(keys[index]!);
      stores.push(new NotificationStore(rt.pool, fixture.tenant));
      const receiver = createNotificationReceiver(stores[index]!);
      receivers.push(receiver);
      await receiver.listen({ host: "127.0.0.1", port: 54256 + index });
    }
  });
  afterAll(async () => {
    for (const worker of workers) await worker.stop();
    for (const receiver of receivers) await receiver.close();
    if (rt) await rt.close();
  });
  it("projects actual subscriptions plus installer hashes and isolates two tenant registries", async () => {
    for (let i = 0; i < 2; i++)
      await new NotificationProjector(
        rt.pool,
        rt.fixtures[i]!.tenant,
        source(i),
      ).reconcile(manifest(i));
    expect(
      (await state()).rows.find((row) => row.service === "j-mail"),
    ).toMatchObject({ active: true, key_hashes: [digest(keys[0]!)] });
    expect((await receive()).status).toBe(200);
    expect((await receive(1, keys[0]!)).status).toBe(401);
    expect((await receive(1)).status).toBe(200);
    expect((await stores[0]!.list(identity)).items).toHaveLength(1);
    expect((await stores[1]!.list(identity)).items).toHaveLength(1);
    expect(JSON.stringify((await state()).rows)).not.toContain(keys[0]!);
  });
  it("reflects actual unsubscribe/re-subscribe while preserving old notifications and the other tenant", async () => {
    const projector = new NotificationProjector(
      rt.pool,
      rt.fixtures[0]!.tenant,
      source(),
    );
    expect((await rt.subscribe(0, "j-mail", "DELETE")).status).toBe(200);
    await projector.reconcile(manifest());
    expect((await receive()).status).toBe(403);
    expect((await stores[0]!.list(identity)).items).toHaveLength(0);
    expect((await stores[1]!.list(identity)).items).toHaveLength(1);
    expect((await rt.subscribe(0, "j-mail")).status).toBe(200);
    await projector.reconcile(manifest());
    expect((await stores[0]!.list(identity)).items).toHaveLength(1);
  });
  it("rotates hashes with an actual overlap deadline and rejects stale/tampered generations", async () => {
    const newer = randomBytes(32).toString("base64url"),
      old = keys[0]!;
    rt.secretValues.add(newer);
    const next = manifest(0, "2", newer);
    next.keys["j-mail"] = {
      currentHash: digest(newer),
      previousHash: digest(old),
      previousExpiresAt: new Date(Date.now() + 1500).toISOString(),
    };
    const projector = new NotificationProjector(
      rt.pool,
      rt.fixtures[0]!.tenant,
      source(),
    );
    await projector.reconcile(next);
    expect((await receive(0, old)).status).toBe(200);
    expect((await receive(0, newer)).status).toBe(200);
    await expect(projector.reconcile(manifest())).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      projector.reconcile(manifest(0, "2", old)),
    ).rejects.toMatchObject({ status: 409 });
    await new Promise((resolve) => setTimeout(resolve, 1550));
    expect((await receive(0, old)).status).toBe(401);
    expect((await receive(0, newer)).status).toBe(200);
    keys[0] = newer;
    await projector.reconcile(manifest(0, "3"));
    await expect(
      stores[0]!.configure({ "j-mail": [digest(old)] }),
    ).rejects.toThrow("owned by the projection worker");
  });
  it("fails closed on an actual auth HTTP outage and recovers without replacing tenant keys", async () => {
    const failed: SubscriptionReader = (tenant, signal) => {
      expect(tenant).toBe(rt.fixtures[0]!.tenant);
      return rt.subscriptionSnapshot(0, signal, (input, init) =>
        rt.fetchLoopback(String(input).replace(":54231", ":54259"), init),
      );
    };
    await expect(
      new NotificationProjector(
        rt.pool,
        rt.fixtures[0]!.tenant,
        failed,
      ).reconcile(manifest(0, "3")),
    ).rejects.toMatchObject({ status: 503 });
    expect((await receive()).status).toBe(403);
    expect((await stores[0]!.list(identity)).items).toHaveLength(0);
    expect(
      (await state()).rows.find((row) => row.service === "j-mail").key_hashes,
    ).toEqual([digest(keys[0]!)]);
    await new NotificationProjector(
      rt.pool,
      rt.fixtures[0]!.tenant,
      source(),
    ).reconcile(manifest(0, "3"));
    expect((await receive()).status).toBe(200);
  });
  it("serializes two real projector instances before authoritative reads and blocks a delayed old generation", async () => {
    let release!: () => void,
      arrive!: () => void,
      secondRead = false;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      arrival = new Promise<void>((resolve) => {
        arrive = resolve;
      });
    const first = new NotificationProjector(
      rt.pool,
      rt.fixtures[0]!.tenant,
      async (tenant, signal) => {
        arrive();
        await gate;
        return source()(tenant, signal);
      },
    );
    const second = new NotificationProjector(
      rt.pool,
      rt.fixtures[0]!.tenant,
      async (tenant, signal) => {
        secondRead = true;
        return source()(tenant, signal);
      },
    );
    const one = first.reconcile(manifest(0, "4"));
    await arrival;
    const two = second.reconcile(manifest(0, "5"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondRead).toBe(false);
    release();
    await Promise.all([one, two]);
    expect(secondRead).toBe(true);
    await expect(first.reconcile(manifest(0, "4"))).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (
        await rt.pool.query(
          "SELECT manifest_revision FROM notification_projection_state WHERE tenant_id=$1",
          [rt.fixtures[0]!.tenant],
        )
      ).rows[0].manifest_revision,
    ).toBe("5");
  });
  it("rolls back all service/manifest changes after a real mid-projection SQL failure", async () => {
    const before = (await state()).rows;
    await rt.pool.query(
      "CREATE FUNCTION fixture_reject_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.service='j-talk' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_reject_projection BEFORE UPDATE ON notification_services FOR EACH ROW EXECUTE FUNCTION fixture_reject_projection()",
    );
    const projector = new NotificationProjector(
      rt.pool,
      rt.fixtures[0]!.tenant,
      source(),
    );
    try {
      await expect(projector.reconcile(manifest(0, "6"))).rejects.toThrow();
    } finally {
      await rt.pool.query(
        "DROP TRIGGER fixture_reject_projection ON notification_services; DROP FUNCTION fixture_reject_projection()",
      );
    }
    expect((await state()).rows).toEqual(before);
    expect(
      (
        await rt.pool.query(
          "SELECT manifest_revision FROM notification_projection_state WHERE tenant_id=$1",
          [rt.fixtures[0]!.tenant],
        )
      ).rows[0].manifest_revision,
    ).toBe("5");
    await projector.reconcile(manifest(0, "6"));
  });
  it("expires source leases at the database clock without a live worker, preserving stored rows", async () => {
    const projector = new NotificationProjector(
      rt.pool,
      rt.fixtures[0]!.tenant,
      source(),
      1,
    );
    await projector.reconcile(manifest(0, "6"));
    expect((await receive()).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await receive()).status).toBe(403);
    expect((await stores[0]!.list(identity)).items).toHaveLength(0);
    expect(
      (
        await rt.pool.query(
          "SELECT count(*) AS n FROM notifications WHERE tenant_id=$1",
          [rt.fixtures[0]!.tenant],
        )
      ).rows[0].n,
    ).not.toBe("0");
  });
  it("rejects untrusted manifests before DB/source effects and disables subscribed services with no installer key", async () => {
    let reads = 0;
    const projector = new NotificationProjector(
      rt.pool,
      rt.fixtures[0]!.tenant,
      async (tenant, signal) => {
        reads++;
        return source()(tenant, signal);
      },
    );
    const before = (await state()).rows;
    const base = manifest(0, "7");
    const invalid: unknown[] = [
      { ...base, tenantId: rt.fixtures[1]!.tenant },
      { ...base, revision: "0" },
      { ...base, revision: "9223372036854775808" },
      { ...base, keys: { "j-mail": { currentHash: keys[0] } } },
      {
        ...base,
        keys: {
          "j-mail": {
            currentHash: digest(keys[0]!),
            previousHash: digest("other"),
          },
        },
      },
      { ...base, keys: { "j-web": { currentHash: digest(keys[0]!) } } },
    ];
    for (const value of invalid)
      await expect(
        projector.reconcile(value as NotificationKeyManifest),
      ).rejects.toThrow();
    expect(reads).toBe(0);
    expect((await state()).rows).toEqual(before);
    await projector.reconcile({ ...base, keys: {} });
    expect(
      (await state()).rows.every(
        (row) => !row.active && row.key_hashes.length === 0,
      ),
    ).toBe(true);
    expect((await receive()).status).toBe(401);
    await projector.reconcile(manifest(0, "8"));
  });
  it("cancels an uncooperative source and releases the transaction for a real recovery", async () => {
    let arrive!: () => void;
    const arrival = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const projector = new NotificationProjector(
      rt.pool,
      rt.fixtures[0]!.tenant,
      async () => {
        arrive();
        return new Promise(() => undefined);
      },
    );
    const abort = new AbortController();
    const work = projector.reconcile(manifest(0, "8"), abort.signal);
    const outcome = expect(work).rejects.toMatchObject({ status: 503 });
    await arrival;
    abort.abort();
    await outcome;
    expect((await receive()).status).toBe(403);
    await new NotificationProjector(
      rt.pool,
      rt.fixtures[0]!.tenant,
      source(),
    ).reconcile(manifest(0, "8"));
    expect((await receive()).status).toBe(200);
  });
  it("automatically refreshes actual subscription changes, retries and stops its isolated worker", async () => {
    let offline = false,
      failures = 0;
    const read: SubscriptionReader = (tenant, signal) =>
      offline
        ? Promise.reject(new Error("fixture unavailable"))
        : source()(tenant, signal);
    const worker = new NotificationProjectionWorker(
      new NotificationProjector(rt.pool, rt.fixtures[0]!.tenant, read),
      () => manifest(0, "8"),
      1000,
      () => {
        failures++;
      },
    );
    workers.push(worker);
    await worker.start();
    expect((await receive()).status).toBe(200);
    expect((await rt.subscribe(0, "j-mail", "DELETE")).status).toBe(200);
    await wait(
      async () =>
        !(await state()).rows.find((row) => row.service === "j-mail").active,
    );
    expect((await receive()).status).toBe(403);
    expect((await rt.subscribe(0, "j-mail")).status).toBe(200);
    offline = true;
    await wait(async () => failures > 0);
    offline = false;
    await wait(async () =>
      Boolean(
        (await state()).rows.find((row) => row.service === "j-mail").active,
      ),
    );
    expect((await receive()).status).toBe(200);
    await worker.stop();
    const stopped = (await state()).rows;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await state()).rows).toEqual(stopped);
  });
  it("starts and restarts the compiled receiver from projected state without static keys or an operator credential", async () => {
    const names = [
      "JGW_NOTIFICATION_REGISTRY_MODE",
      "JGW_INTERNAL_NOTIFICATIONS_PORT",
      "JGW_NOTIFICATION_SERVICE_KEY_HASHES",
    ] as const;
    const previous = names.map((name) => process.env[name]);
    process.env.JGW_NOTIFICATION_REGISTRY_MODE = "projection";
    process.env.JGW_INTERNAL_NOTIFICATIONS_PORT = "54258";
    delete process.env.JGW_NOTIFICATION_SERVICE_KEY_HASHES;
    const before = (await state()).rows;
    try {
      for (let i = 0; i < 2; i++) {
        const child = await rt.startCompiled();
        try {
          const compiledEnv = await readFile(
            `/proc/${child.pid}/environ`,
            "utf8",
          );
          expect(compiledEnv.includes("JAUTH_CONSOLE_SERVICE_KEY=")).toBe(
            false,
          );
          expect(
            compiledEnv.includes("JGW_NOTIFICATION_SERVICE_KEY_HASHES="),
          ).toBe(false);
          const response = await rt.fetchLoopback(
            "http://127.0.0.1:54258/internal/notifications",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-JGW-Internal-Key": keys[0]!,
              },
              body: JSON.stringify({
                tenant: rt.fixtures[0]!.tenant,
                service: "j-mail",
                type: "mail.new",
                usernames: ["recipient"],
                title: "compiled 투영",
                body: "",
                link: "/mail/messages/fixture-message",
                dedupKey: randomUUID(),
              }),
            },
          );
          expect(response.status).toBe(200);
          expect((await state()).rows).toEqual(before);
        } finally {
          await rt.stop(child);
        }
        expect(child.exitCode).toBe(0);
      }
      for (const secret of rt.secretValues)
        expect(rt.logs.join("")).not.toContain(secret);
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });
  it("projects a durable installer manifest against actual subscriptions, reuses hashes, retries an actual outage and removes receiver authorization", async () => {
    const tenant = rt.fixtures[1]!.tenant,
      root = await mkdtemp(
        "/workspace/.suite-runtime/j-groupware/notification-manifest-",
      );
    try {
      const projector = new NotificationProjector(rt.pool, tenant, source(1));
      const producer = new NotificationManifest({ root, tenant, projector });
      expect((await producer.register("j-mail", keys[1]!)).revision).toBe("1");
      const before = await readFile(root + "/notification-keys.json", "utf8");
      expect(before).not.toContain(keys[1]!);
      expect((await lstat(root + "/notification-keys.json")).mode & 0o077).toBe(
        0,
      );
      expect((await receive(1)).status).toBe(200);
      expect((await producer.register("j-mail", keys[1]!)).revision).toBe("1");
      expect(await readFile(root + "/notification-keys.json", "utf8")).toBe(
        before,
      );
      await expect(
        producer.register("j-mail", randomBytes(32).toString("base64url")),
      ).rejects.toMatchObject({ code: "notification_key_conflict" });
      expect((await rt.subscribe(1, "j-approval")).status).toBe(200);
      const approvalKey = randomBytes(32).toString("base64url");
      rt.secretValues.add(approvalKey);
      const failed = new NotificationManifest({
        root,
        tenant,
        projector: new NotificationProjector(rt.pool, tenant, (id, signal) =>
          rt.subscriptionSnapshot(1, signal, (input, init) =>
            rt.fetchLoopback(String(input).replace(":54231", ":54259"), init),
          ),
        ),
      });
      await expect(
        failed.register("j-approval", approvalKey),
      ).rejects.toMatchObject({ code: "notification_projection_failed" });
      expect((await producer.read())!.revision).toBe("2");
      expect((await receive(1)).status).toBe(403);
      expect(
        (await producer.register("j-approval", approvalKey)).revision,
      ).toBe("2");
      expect(
        (await state(1)).rows.find((row) => row.service === "j-approval"),
      ).toMatchObject({ active: true, key_hashes: [digest(approvalKey)] });
      expect((await receive(1)).status).toBe(200);
      expect((await producer.remove("j-mail")).revision).toBe("3");
      expect((await receive(1)).status).toBe(401);
      expect((await producer.remove("j-mail")).revision).toBe("3");
      expect((await producer.refresh()).revision).toBe("3");
      expect((await producer.read())!.keys["j-mail"]).toBeUndefined();
      expect((await stores[1]!.list(identity)).items).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses a symlinked or foreign-tenant installer manifest before changing PG registry state", async () => {
    const tenant = rt.fixtures[1]!.tenant,
      root = await mkdtemp(
        "/workspace/.suite-runtime/j-groupware/notification-manifest-unsafe-",
      );
    const producer = new NotificationManifest({
      root,
      tenant,
      projector: new NotificationProjector(rt.pool, tenant, source(1)),
    });
    const previous = (await state(1)).rows;
    try {
      const target = root + "/preserved";
      await writeFile(target, "preserve", { mode: 0o600 });
      await symlink(target, root + "/notification-keys.json");
      await expect(producer.refresh()).rejects.toMatchObject({
        code: "unsafe_notification_manifest",
      });
      expect(await readFile(target, "utf8")).toBe("preserve");
      await rm(root + "/notification-keys.json");
      await writeFile(
        root + "/notification-keys.json",
        JSON.stringify({
          tenantId: rt.fixtures[0]!.tenant,
          revision: "99",
          keys: {},
        }),
        { mode: 0o600 },
      );
      await expect(producer.refresh()).rejects.toMatchObject({
        code: "invalid_notification_manifest",
      });
      expect((await state(1)).rows).toEqual(previous);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
