"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { passwordSchema } from "@lifesync/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AuthShell } from "@/components/app/auth-shell";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { api, applyFormError } from "@/lib/api";

const schema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { error: "Passwords do not match", path: ["confirm"] });
type Values = z.infer<typeof schema>;

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  if (!token) {
    return (
      <AuthShell title="Link missing" subtitle="Open the link from your reset email, or request a new one.">
        <Link href="/forgot-password" className="text-sm font-medium underline underline-offset-2">
          Request a new link
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="You'll be signed out on all devices.">
      <form
        className="space-y-4"
        noValidate
        onSubmit={handleSubmit(async (values) => {
          setFormError(null);
          try {
            await api("/api/auth/reset-password", { body: { token, password: values.password } });
            toast.success("Password updated. Sign in with your new password.");
            router.replace("/login");
          } catch (e) {
            setFormError(applyFormError(e, setError));
          }
        })}
      >
        <FormError message={formError} />
        <Field label="New password" error={errors.password?.message} hint="At least 8 characters.">
          {(p) => <Input type="password" autoComplete="new-password" {...p} {...register("password")} />}
        </Field>
        <Field label="Confirm password" error={errors.confirm?.message}>
          {(p) => <Input type="password" autoComplete="new-password" {...p} {...register("confirm")} />}
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
