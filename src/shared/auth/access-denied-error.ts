import { NamedError } from "@/shared/errors/named-error";

export class AccessDeniedError extends NamedError {
  constructor() {
    super("access_denied", "無法驗證存取權限。");
    this.name = "AccessDeniedError";
  }
}

