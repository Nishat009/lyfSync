import { redirect } from "next/navigation";

// Signed-out visitors are sent on to /login by the app layout.
export default function Home() {
  redirect("/my-day");
}
