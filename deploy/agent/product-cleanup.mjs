import { ProvisionError } from "./provision-error.mjs";
import { serviceDatabase } from "./service-database.mjs";

// Approval and Talk have no independent durable file store. The lifecycle has
// already stopped their unit, backed up any DB and revoked LOGIN. Retain that
// database and compiled bundle; this adapter never drops or purges either.
export class ProductCleanup {
  constructor({ web, messenger, mail, customerAuth } = {}) {
    Object.assign(this, { web, messenger, mail, customerAuth });
  }
  async run(service) {
    serviceDatabase(service);
    if (["j-approval", "j-talk", "j-customer-auth-db"].includes(service))
      return { service, storage: "postgres", data: "retained" };
    const adapter = {
      "j-web": this.web,
      "j-messenger": this.messenger,
      "j-mail": this.mail,
      "j-customer-auth-db": this.customerAuth,
    }[service];
    if (!adapter?.run) throw new ProvisionError("cleanup_adapter_unbound");
    return adapter.run(service);
  }
}
