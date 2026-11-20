import type { Metadata } from "next";
import DocPage from "@/app/docs/[slug]/page";
import { DOCS } from "@/lib/docs";

export const metadata: Metadata = { title: "Documentation" };

// The documentation starts at its first guide (Overview), served here as is
// so /docs answers 200: the CI and the production stack checks probe it.
export default function DocsPage() {
  return DocPage({ params: Promise.resolve({ slug: DOCS[0]!.slug }) });
}
