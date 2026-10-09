import { randomBytes, createHash } from "node:crypto";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { BUNDLE_SERVICES } from "./product-environment.mjs";
import { ProvisionError } from "./provision-error.mjs";

const fail = (code) => {
  throw new ProvisionError(code);
};
// Connects the prepared installation ports. OS package/trust/timer activation is
// intentionally a separate prerequisite; this result means base_ready only.
export class BaseBootstrap {
  constructor({
    bootstrap,
    bundles,
    state,
    lock,
    database,
    environment,
    platform,
    gateway,
    preflight,
  }) {
    assertCustomerTenantId(bootstrap?.tenant);
    if (
      !Array.isArray(bootstrap.bundles) ||
      !bootstrap.bundles.length ||
      !bootstrap.bundles.some((b) => b.service === "j-groupware") ||
      new Set(bootstrap.bundles.map((b) => b.service)).size !==
        bootstrap.bundles.length ||
      bootstrap.bundles.some(
        (b) =>
          !BUNDLE_SERVICES.includes(b.service) ||
          !/^[a-f0-9]{64}$/.test(b.digest),
      ) ||
      !bundles?.install ||
      !state?.read ||
      !state?.write ||
      !lock?.acquire ||
      !database?.prepareBase ||
      !database?.ensure ||
      !environment?.prepare ||
      !platform?.preflight ||
      !platform?.install ||
      !platform?.start ||
      !platform?.ready ||
      !gateway?.initialize ||
      typeof preflight !== "function"
    )
      fail("invalid_bootstrap_runtime");
    this.plan = Object.freeze(
      bootstrap.bundles
        .map((b) => Object.freeze({ ...b }))
        .sort((a, b) => a.service.localeCompare(b.service)),
    );
    this.digest = createHash("sha256")
      .update(
        JSON.stringify(
          this.plan.map(({ service, digest }) => ({ service, digest })),
        ),
      )
      .digest("hex");
    Object.assign(this, {
      tenant: bootstrap.tenant,
      bundles,
      state,
      lock,
      database,
      environment,
      platform,
      gateway,
      preflight,
    });
  }
  async run(signal) {
    if (signal?.aborted) fail("bootstrap_cancelled");
    try {
      await this.preflight();
    } catch (error) {
      throw new ProvisionError(
        error instanceof ProvisionError ? error.code : "bootstrap_failed",
      );
    }
    if (signal?.aborted) fail("bootstrap_cancelled");
    const release = await this.lock.acquire();
    if (!release) fail("busy");
    let state,
      phase = "preflight";
    const record = async (status) => {
      state = {
        tenant: this.tenant,
        service: "j-groupware",
        status,
        phase,
        action: "bootstrap",
        bundlePlanSha256: this.digest,
      };
      await this.state.write("j-groupware", state);
    };
    const cancelled = () => {
      if (signal?.aborted) fail("bootstrap_cancelled");
    };
    try {
      state = await this.state.read("j-groupware");
      if (
        state &&
        (state.action !== "bootstrap" ||
          state.bundlePlanSha256 !== this.digest ||
          ["removed", "removing"].includes(state.status))
      )
        fail("bootstrap_state_conflict");
      // Unbound prerequisites and changed intent fail before state/DB/OS mutation.
      cancelled();
      phase = "bundles";
      await record("installing");
      for (const bundle of this.plan) {
        cancelled();
        const result = await this.bundles.install(bundle, signal);
        if (
          result?.service !== bundle.service ||
          result.phase !== "ready" ||
          result.archiveSha256 !== bundle.digest
        )
          fail("bundle_not_ready");
      }
      await this.platform.preflight("j-groupware");
      cancelled();
      phase = "database_base";
      await record("installing");
      await this.database.prepareBase();
      phase = "environment";
      await record("installing");
      const secrets = await this.environment.prepare("j-groupware", () => ({
        databasePassword: randomBytes(32).toString("base64url"),
        notificationKey: randomBytes(32).toString("base64url"),
      }));
      cancelled();
      phase = "database";
      await record("installing");
      await this.database.ensure("j-groupware", secrets.databasePassword);
      cancelled();
      phase = "unit";
      await record("installing");
      await this.platform.install("j-groupware");
      cancelled();
      phase = "start";
      await record("installing");
      await this.platform.start("j-groupware");
      await this.platform.ready("j-groupware");
      cancelled();
      phase = "gateway";
      await record("installing");
      await this.gateway.initialize();
      phase = "active";
      await record("active");
      return {
        tenant: this.tenant,
        phase: "base_ready",
        agentActivation: "pending",
      };
    } catch (error) {
      const code =
        error instanceof ProvisionError ? error.code : "bootstrap_failed";
      // Do not overwrite incompatible or unvalidated intent on preflight refusal.
      if (phase !== "preflight") {
        await record("failed").catch(() => {});
        await this.state
          .write("j-groupware", { ...state, error: code })
          .catch(() => {});
      }
      throw new ProvisionError(code);
    } finally {
      await release();
    }
  }
}
