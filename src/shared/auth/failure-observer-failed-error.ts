import { NamedError } from "@/shared/errors/named-error";

export class FailureObserverFailedError extends NamedError {
  constructor() {
    super("failure_observer_failed", "無法記錄私有操作失敗事件。");
    this.name = "FailureObserverFailedError";
  }
}
