import { CircleQuestionMarkIcon } from "lucide-react";
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
  const tourDisabled = !projectRoot;
  const tourHint = t("help.tourNeedsProject");

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
          <CircleQuestionMarkIcon
            aria-hidden
            className={cn("size-4", iconClassName)}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <span title={tourDisabled ? tourHint : undefined} className="block">
          <DropdownMenuItem
            data-testid="help-take-tour"
            disabled={tourDisabled}
            onSelect={() => {
              if (!projectRoot) return;
              requestProductTourReplay();
            }}
          >
            {t("help.takeTour")}
          </DropdownMenuItem>
        </span>
        {tourDisabled ? (
          <p
            data-testid="help-tour-hint"
            className="px-2 pt-0.5 pb-1 text-muted-foreground text-xs"
          >
            {tourHint}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
