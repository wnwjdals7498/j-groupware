import { ProvisionError } from "./provision-error.mjs";
import { serviceDatabase } from "./service-database.mjs";

// Approval and Talk have no independent durable file store. The lifecycle has
// already stopped their unit, backed up any DB and revoked LOGIN. Retain that
// database and compiled bundle; this adapter never drops or purges either.
export class ProductCleanup {
  constructor({ web, messenger, mail, customerAuth } = {}) {
    Object.assign(this, { web, messenger, mail, customerAuth });
  }
  adapter(service) {
    return {
      "j-web": this.web,
      "j-messenger": this.messenger,
      "j-mail": this.mail,
      "j-customer-auth-db": this.customerAuth,
    }[service];
  }
  async preflight(service) {
    serviceDatabase(service);
    if (["j-messenger", "j-mail"].includes(service)) {
      const adapter = this.adapter(service);
      if (!adapter?.preflight)
        throw new ProvisionError("cleanup_adapter_unbound");
      return adapter.preflight(service);
    }
  }
  async prepare(service) {
    serviceDatabase(service);
    if (["j-messenger", "j-mail"].includes(service)) {
      const adapter = this.adapter(service);
      if (!adapter?.prepare)
        throw new ProvisionError("cleanup_adapter_unbound");
      return adapter.prepare(service);
    }
  }
  async run(service, context) {
    serviceDatabase(service);
    if (["j-approval", "j-talk", "j-customer-auth-db"].includes(service))
      return { service, storage: "postgres", data: "retained" };
    const adapter = this.adapter(service);
    if (!adapter?.run) throw new ProvisionError("cleanup_adapter_unbound");
    return adapter.run(service, context);
  }
  async verifyRetained(service, context) {
    serviceDatabase(service);
    if (["j-approval", "j-talk", "j-customer-auth-db"].includes(service))
      return { service, storage: "postgres", data: "retained" };
    const adapter = this.adapter(service);
    if (!adapter?.verifyRetained)
      throw new ProvisionError("retained_cleanup_verification_unbound");
    return adapter.verifyRetained(service, context);
  }
}
