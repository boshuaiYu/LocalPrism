import { writeTexFileContent } from "@/lib/tauri/fs";
import {
  type ProjectFsOwner,
  runProjectFsOperation,
} from "@/lib/project-fs-operations";

const fileWriteQueues = new Map<string, Promise<void>>();

/**
 * Serializes every managed text write to one absolute path and registers the
 * whole queued write as an active project filesystem operation.
 */
export function writeProjectTextFileInOrder(
  owner: ProjectFsOwner,
  absolutePath: string,
  content: string,
): Promise<void> {
  return runProjectFsOperation(owner, async () => {
    const previous = fileWriteQueues.get(absolutePath) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => writeTexFileContent(absolutePath, content));
    fileWriteQueues.set(absolutePath, write);
    try {
      await write;
    } finally {
      if (fileWriteQueues.get(absolutePath) === write) {
        fileWriteQueues.delete(absolutePath);
      }
    }
  });
}
