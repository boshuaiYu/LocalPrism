import { CircleQuestionMarkIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { requestProductTourReplay } from "@/lib/product-tour";
import { useI18n } from "@/lib/use-i18n";
import { cn } from "@/lib/utils";
import { useDocumentStore } from "@/stores/document-store";

export function HelpMenu({
  className,
  iconClassName,
}: {
  className?: string;
  iconClassName?: string;
}) {
  const { t } = useI18n();
  const projectRoot = useDocumentStore((state) => state.projectRoot);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("size-8", className)}
          data-testid="help-menu"
          title={t("help.menu")}
          aria-label={t("help.menu")}
        >
          <CircleQuestionMarkIcon className={cn("size-4", iconClassName)} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem
          data-testid="help-take-tour"
          onSelect={() => {
            requestProductTourReplay();
            if (!projectRoot) toast.message(t("help.tourNeedsProject"));
          }}
        >
          {t("help.takeTour")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
