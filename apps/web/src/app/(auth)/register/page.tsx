"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { registerSchema, type RegisterInput } from "@lifesync/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { AuthShell, useRedirectIfSignedIn } from "@/components/app/auth-shell";
import { GoogleButton } from "@/components/app/google-button";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { api, applyFormError } from "@/lib/api";
import { invalidate } from "@/lib/use-query";

export default function RegisterPage() {
  const router = useRouter();
  useRedirectIfSignedIn(null);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({ resolver: zodResolver(registerSchema) });

  const done = () => {
    invalidate("/api/me");
    router.replace("/my-day");
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="Your private personal workspace is created automatically."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline underline-offset-2">
            Sign in
          </Link>
        </>
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={handleSubmit(async (values) => {
          setFormError(null);
          try {
            // The browser's own zone keeps reminders and "today" correct from day one.
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            await api("/api/auth/register", { body: { ...values, timezone } });
            done();
          } catch (e) {
            setFormError(applyFormError(e, setError));
          }
        })}
      >
        <FormError message={formError} />
        <Field label="Full name" error={errors.fullName?.message}>
          {(p) => <Input autoComplete="name" {...p} {...register("fullName")} />}
        </Field>
        <Field label="Email" error={errors.email?.message}>
          {(p) => <Input type="email" autoComplete="email" {...p} {...register("email")} />}
        </Field>
        <Field label="Password" error={errors.password?.message} hint="At least 8 characters.">
          {(p) => <Input type="password" autoComplete="new-password" {...p} {...register("password")} />}
        </Field>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          Create account
        </Button>
      </form>
      <GoogleButton
        onCredential={async (credential) => {
          try {
            await api("/api/auth/google", { body: { credential } });
            done();
          } catch (e) {
            setFormError(e instanceof Error ? e.message : "Google sign-in failed");
          }
        }}
      />
    </AuthShell>
  );
}
