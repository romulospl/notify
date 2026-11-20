import { redirect } from "next/navigation";
import { DOCS_URL } from "@/components/site/site-shell";
import { DOCS } from "@/lib/docs";

// The documentation starts at its first guide (Overview).
export default function DocsPage() {
  redirect(`${DOCS_URL}/${DOCS[0]!.slug}`);
}
