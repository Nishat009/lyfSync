"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@lifesync/shared";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { AuthShell } from "@/components/app/auth-shell";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { api, applyFormError } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema) });

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We'll email you a link to choose a new one."
      footer={
        <Link href="/login" className="font-medium text-foreground underline underline-offset-2">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <p role="status" className="rounded-lg bg-personal-soft px-3 py-3 text-sm text-personal">
          If an account exists for that email, a reset link is on its way. It works for one hour.
        </p>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={handleSubmit(async (values) => {
            setFormError(null);
            try {
              await api("/api/auth/forgot-password", { body: values });
              setSent(true);
            } catch (e) {
              setFormError(applyFormError(e, setError));
            }
          })}
        >
          <FormError message={formError} />
          <Field label="Email" error={errors.email?.message}>
            {(p) => <Input type="email" autoComplete="email" {...p} {...register("email")} />}
          </Field>
          <Button type="submit" className="w-full" loading={isSubmitting}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
