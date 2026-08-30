import { NamedError } from "@/shared/errors/named-error";

export class PrivateOperationFailedError extends NamedError {
  constructor() {
    super("private_operation_failed", "暫時無法完成操作。");
    this.name = "PrivateOperationFailedError";
  }
}
