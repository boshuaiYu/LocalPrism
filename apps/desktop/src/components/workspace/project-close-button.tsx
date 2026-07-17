import { useRef, useState } from "react";
import { HomeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const BUSY_CLOSE_LABEL = "Stop all runtime turns before closing the project";
const CLOSING_LABEL = "Closing project";

export function ProjectCloseButton({
  runtimeBusy,
  onClose,
  className,
}: {
  runtimeBusy: boolean;
  onClose: () => boolean | Promise<boolean>;
  className?: string;
}) {
  const [isClosing, setIsClosing] = useState(false);
  const closePendingRef = useRef(false);
  const disabled = runtimeBusy || isClosing;
  const label = runtimeBusy
    ? BUSY_CLOSE_LABEL
    : isClosing
      ? CLOSING_LABEL
      : "Close Project";

  const handleClose = async () => {
    if (runtimeBusy || closePendingRef.current) return;
    closePendingRef.current = true;
    setIsClosing(true);
    try {
      await onClose();
    } finally {
      closePendingRef.current = false;
      setIsClosing(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      onClick={() => void handleClose()}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <HomeIcon className="size-3.5" />
    </Button>
  );
}
