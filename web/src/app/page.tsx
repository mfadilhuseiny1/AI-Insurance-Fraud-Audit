import { redirect } from "next/navigation";

/** AI JKN Audit opens on AIP JKN: the platform's home page (parse jobs, usage) is not part of this app. */
export default function Home() {
  redirect("/aip-jkn");
}
