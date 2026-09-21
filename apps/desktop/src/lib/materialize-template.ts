import { createFileOnDisk, exists, join } from "@/lib/tauri/fs";
import {
  getTemplateProjectFiles,
  type TemplateDefinition,
} from "@/lib/template-registry";

/** Write the full template example (main file, extras, bibliography) into a new project. */
export async function materializeTemplateProject(
  projectPath: string,
  template: TemplateDefinition,
): Promise<void> {
  for (const file of getTemplateProjectFiles(template)) {
    const dest = await join(projectPath, file.path);
    if (!(await exists(dest))) {
      await createFileOnDisk(projectPath, file.path, file.content);
    }
  }
}
