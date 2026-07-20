import { SettingsIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RuntimeSettings } from "@/components/runtime/runtime-settings";
import { SkillLibrary } from "@/components/skills/skill-library";
import { AgentLibrary } from "@/components/agents/agent-library";
import { useDocumentStore } from "@/stores/document-store";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: "runtimes" | "skills" | "agents";
}

export function SettingsDialog({
  open,
  onOpenChange,
  defaultTab = "runtimes",
}: SettingsDialogProps) {
  const projectPath = useDocumentStore((state) => state.projectRoot);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[min(48rem,calc(100vw-2rem))] flex-col overflow-hidden sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon className="size-4" />
            Settings
          </DialogTitle>
          <DialogDescription>
            Configure AI runtimes, skills, and custom agents.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          defaultValue={defaultTab}
          className="flex min-h-0 flex-1 flex-col gap-3"
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="runtimes">AI Runtimes</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
          </TabsList>

          <TabsContent
            value="runtimes"
            className="mt-0 min-h-0 flex-1 overflow-y-auto"
          >
            <RuntimeSettings />
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
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
