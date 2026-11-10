"use client";

import { X } from "lucide-react";
import { Dialog as D, DropdownMenu as M } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  side,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /** "left" renders a drawer, used for the mobile navigation. */
  side?: "left";
}) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <D.Content
        className={cn(
          "fixed z-50 border border-border bg-surface shadow-xl focus:outline-none",
          side === "left"
            ? "inset-y-0 left-0 w-72 data-[state=open]:animate-in data-[state=open]:slide-in-from-left"
            : "left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl p-5 data-[state=open]:animate-in data-[state=open]:fade-in-0 max-h-[90vh] overflow-y-auto",
          className,
        )}
      >
        {side === "left" ? (
          <>
            <D.Title className="sr-only">{title}</D.Title>
            <D.Description className="sr-only">{description ?? title}</D.Description>
          </>
        ) : (
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description && <D.Description className="mt-1 text-sm text-muted">{description}</D.Description>}
            </div>
            <D.Close className="rounded-md p-1 text-muted hover:bg-surface-muted" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
        )}
        {children}
      </D.Content>
    </D.Portal>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  onConfirm,
  children,
  confirmDisabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  /** Throw to keep the dialog open (for example after showing an error). */
  onConfirm: () => Promise<void> | void;
  children?: React.ReactNode;
  confirmDisabled?: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent title={title} description={description}>
        {children}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            loading={busy}
            disabled={confirmDisabled}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch {
                // the caller already reported the problem; leave the dialog open
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({ className, ...props }: React.ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        align="end"
        sideOffset={6}
        className={cn(
          "z-50 min-w-48 rounded-xl border border-border bg-surface p-1 shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0",
          className,
        )}
        {...props}
      />
    </M.Portal>
  );
}

export function MenuItem({ className, ...props }: React.ComponentProps<typeof M.Item>) {
  return (
    <M.Item
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-muted [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}

export const MenuSeparator = ({ className }: { className?: string }) => (
  <M.Separator className={cn("my-1 h-px bg-border", className)} />
);
export const MenuLabel = M.Label;
