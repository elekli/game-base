import type { BeginMediaUploadCommand } from "../contracts";
import type { MediaIngest } from "./types";

export function matchesUploadCommand(ingest: MediaIngest, command: BeginMediaUploadCommand): boolean {
  return ingest.gameId === command.gameId
    && ingest.purpose === command.purpose
    && ingest.originalFileName === command.originalFileName
    && ingest.declaredMimeType === command.declaredMimeType
    && ingest.declaredByteSize === command.declaredByteSize;
}
