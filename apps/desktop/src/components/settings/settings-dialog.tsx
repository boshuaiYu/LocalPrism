import { SettingsIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PreviewSettings } from "@/components/settings/preview-settings";
import { RuntimeSettings } from "@/components/runtime/runtime-settings";
import { SkillLibrary } from "@/components/skills/skill-library";
import { AgentLibrary } from "@/components/agents/agent-library";
import { useProductTourDialogGuard } from "@/components/product-tour";
import { useDocumentStore } from "@/stores/document-store";
import { useI18n } from "@/lib/use-i18n";

export type SettingsTab = "runtimes" | "skills" | "agents" | "preview";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: SettingsTab;
}

export function SettingsDialog({
  open,
  onOpenChange,
  defaultTab = "runtimes",
}: SettingsDialogProps) {
  const { t } = useI18n();
  const projectPath = useDocumentStore((state) => state.projectRoot);
  const tourDialog = useProductTourDialogGuard();

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={tourDialog.modal}>
      <DialogContent
        onInteractOutside={tourDialog.onInteractOutside}
        className="flex h-[min(85vh,52rem)] max-h-[85vh] min-h-0 w-[min(48rem,calc(100vw-2rem))] flex-col overflow-hidden sm:max-w-none"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon className="size-4" />
            {t("settings.title")}
          </DialogTitle>
          <DialogDescription className="text-lp-meta">
            {t("settings.description")}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          key={defaultTab}
          defaultValue={defaultTab}
          className="flex min-h-0 flex-1 flex-col gap-3"
        >
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="runtimes">
              {t("settings.providers")}
            </TabsTrigger>
            <TabsTrigger value="skills">{t("settings.skills")}</TabsTrigger>
            <TabsTrigger value="agents">{t("settings.agents")}</TabsTrigger>
            <TabsTrigger value="preview">{t("settings.preview")}</TabsTrigger>
          </TabsList>

          <TabsContent
            value="runtimes"
            className="mt-0 min-h-0 flex-1 overflow-y-auto"
          >
            <div className="flex flex-col gap-4">
              <RuntimeSettings />
            </div>
          </TabsContent>

          <TabsContent
            value="skills"
            className="mt-0 min-h-0 flex-1 overflow-y-auto px-1"
          >
            <SkillLibrary projectPath={projectPath} />
          </TabsContent>

          <TabsContent
            value="agents"
            className="mt-0 min-h-0 flex-1 overflow-y-auto px-1"
          >
            <AgentLibrary projectPath={projectPath} />
          </TabsContent>

          <TabsContent
            value="preview"
            className="mt-0 min-h-0 flex-1 overflow-y-auto px-1"
          >
            <PreviewSettings />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
