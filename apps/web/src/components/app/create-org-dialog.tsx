"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { createOrganizationSchema, type CreateOrganizationInput, type WorkspaceSummary } from "@lifesync/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, FormError, Input, Textarea } from "@/components/ui/form";
import { api, applyFormError } from "@/lib/api";
import { invalidate } from "@/lib/use-query";

export function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrganizationInput>({ resolver: zodResolver(createOrganizationSchema) });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          setFormError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent
        title="Create organization"
        description="A shared workspace for projects and teammates. You'll be its admin."
      >
        <form
          className="space-y-4"
          noValidate
          onSubmit={handleSubmit(async (values) => {
            setFormError(null);
            try {
              const ws = await api<WorkspaceSummary>("/api/workspaces", { body: values });
              invalidate("/api/me");
              toast.success(`${ws.name} created`);
              onOpenChange(false);
              reset();
              router.push(`/w/${ws.id}`);
            } catch (e) {
              setFormError(applyFormError(e, setError));
            }
          })}
        >
          <FormError message={formError} />
          <Field label="Name" error={errors.name?.message}>
            {(p) => <Input placeholder="Acme Inc." {...p} {...register("name")} />}
          </Field>
          <Field label="Description (optional)" error={errors.description?.message}>
            {(p) => <Textarea {...p} {...register("description")} />}
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="work" loading={isSubmitting}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
