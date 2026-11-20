import { type NextRequest, NextResponse } from "next/server";

// The portal has no signed-in pages: the proxy only answers 404 for the
// disabled image optimizer.
export function proxy(request: NextRequest) {
  // The optimizer is off and its library does not ship with the image.
  // The matcher normalizes the trailing slash and also tests the decoded path,
  // so the comparison repeats that: without it, /_next/image/ or /_next/%69mage
  // would get through the matcher and fall into the session redirect.
  const pathname = request.nextUrl.pathname.replace(/\/+$/, "");
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Invalid percent-encoding: carry on without decoding; Next answers later.
  }
  if (decoded === "/_next/image") {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/_next/image"],
};
