import { SERVICE_CATALOG } from "@j-auth/contracts";
import {
  renderGateway,
  applyGateway,
  externalPath,
  loadGatewayProfile,
} from "../gateway/gateway.mjs";
import { ProvisionError, serviceDatabase } from "./service-database.mjs";

const optional = SERVICE_CATALOG.filter(
  (s) => s.tenantService && !s.required,
).map((s) => s.serviceId);
export class ProductGateway {
  constructor({ root, profile, state, commands, substitute }) {
    externalPath(root);
    loadGatewayProfile(profile);
    if (
      !state?.read ||
      state.tenant !== profile.JGW_TENANT ||
      !commands?.validate ||
      !commands?.reload
    )
      throw new ProvisionError("invalid_configuration");
    Object.assign(this, {
      root,
      profile: Object.freeze({ ...profile }),
      state,
      commands,
      substitute,
    });
  }
  async set(service, enabled) {
    serviceDatabase(service);
    if (!optional.includes(service) || typeof enabled !== "boolean")
      throw new ProvisionError("invalid_action");
    const installed = [];
    for (const candidate of optional) {
      if (candidate === service) {
        if (enabled) installed.push(candidate);
      } else if ((await this.state.read(candidate))?.status === "active")
        installed.push(candidate);
    }
    const files = await renderGateway(
      { ...this.profile, JGW_GATEWAY_SERVICES: installed.join(",") },
      this.root,
      this.substitute,
    );
    // applyGateway observes the new Nginx worker, restores on validation/reload
    // failure and preserves j-web's files. The lifecycle records active later.
    return applyGateway(this.root, files, this.commands);
  }
}
