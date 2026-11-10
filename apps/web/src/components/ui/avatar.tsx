import { Avatar as A } from "radix-ui";
import { cn, initials } from "@/lib/utils";

export function Avatar({
  name,
  src,
  className,
}: {
  name: string;
  src?: string | null;
  className?: string;
}) {
  return (
    <A.Root className={cn("inline-flex size-8 shrink-0 select-none overflow-hidden rounded-full bg-surface-muted", className)}>
      {src && <A.Image src={src} alt="" className="size-full object-cover" />}
      <A.Fallback className="flex size-full items-center justify-center text-xs font-medium text-muted">
        {initials(name)}
      </A.Fallback>
    </A.Root>
  );
}
