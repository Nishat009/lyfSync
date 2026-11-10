"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema, type LoginInput } from "@lifesync/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { AuthShell, safeNext, useRedirectIfSignedIn } from "@/components/app/auth-shell";
import { GoogleButton } from "@/components/app/google-button";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { api, applyFormError } from "@/lib/api";
import { invalidate } from "@/lib/use-query";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  useRedirectIfSignedIn(next);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  const done = () => {
    invalidate("/api/me");
    router.replace(safeNext(next));
  };

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to continue to LifeSync."
      footer={
        <>
          New here?{" "}
          <Link href="/register" className="font-medium text-foreground underline underline-offset-2">
            Create an account
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
            await api("/api/auth/login", { body: values });
            done();
          } catch (e) {
            setFormError(applyFormError(e, setError));
          }
        })}
      >
        <FormError message={formError} />
        <Field label="Email" error={errors.email?.message}>
          {(p) => <Input type="email" autoComplete="email" {...p} {...register("email")} />}
        </Field>
        <Field label="Password" error={errors.password?.message}>
          {(p) => <Input type="password" autoComplete="current-password" {...p} {...register("password")} />}
        </Field>
        <div className="text-right text-sm">
          <Link href="/forgot-password" className="text-muted underline underline-offset-2">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" className="w-full" loading={isSubmitting}>
          Sign in
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

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
