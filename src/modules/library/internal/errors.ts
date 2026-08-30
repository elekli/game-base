import { NamedError } from "@/shared/errors/named-error";

export type LibraryErrorCode = "library_system_platform" | "library_item_in_use";

export class LibraryConflictError extends NamedError {
  constructor(public readonly libraryCode: LibraryErrorCode, message: string) {
    super(libraryCode, message);
    this.name = "LibraryConflictError";
  }
}
