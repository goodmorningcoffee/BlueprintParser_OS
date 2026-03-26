import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * GET /api/labeling/login?redirect=/projects/123
 *
 * Auto-login relay for Label Studio.
 * Server-side CSRF form login → extract session cookie → set on browser via
 * HTML relay page (not 307 redirect, which drops Set-Cookie cross-origin).
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const redirect = url.searchParams.get("redirect") || "/";

  const lsUrl = process.env.LABEL_STUDIO_URL;
  const lsEmail = process.env.LABEL_STUDIO_ADMIN_EMAIL;
  const lsPassword = process.env.LABEL_STUDIO_ADMIN_PASSWORD;

  if (!lsUrl || !lsEmail || !lsPassword) {
    return NextResponse.json(
      { error: "Label Studio not configured" },
      { status: 503 }
    );
  }

  try {
    // Step 1: GET login page for CSRF token
    const loginPageRes = await fetch(`${lsUrl}/user/login/`, {
      redirect: "manual",
      headers: { "User-Agent": "BlueprintParser/1.0" },
      signal: AbortSignal.timeout(10000),
    });

    // Extract csrftoken from Set-Cookie header
    let csrfToken = "";

    const rawSetCookie = loginPageRes.headers.get("set-cookie") || "";
    const csrfMatch = rawSetCookie.match(/csrftoken=([^;,\s]+)/);
    if (csrfMatch) {
      csrfToken = csrfMatch[1];
    }

    // Fallback: try getSetCookie()
    if (!csrfToken && typeof loginPageRes.headers.getSetCookie === "function") {
      for (const c of loginPageRes.headers.getSetCookie()) {
        const m = c.match(/csrftoken=([^;]+)/);
        if (m) { csrfToken = m[1]; break; }
      }
    }

    // Fallback: extract from HTML body
    if (!csrfToken) {
      const html = await loginPageRes.text().catch(() => "");
      const htmlMatch = html.match(/csrfmiddlewaretoken['"]?\s*(?:value=|:)\s*['"]([^'"]+)['"]/i);
      if (htmlMatch) csrfToken = htmlMatch[1];
    }

    if (!csrfToken) {
      console.error("[LS-LOGIN] No CSRF token found, login page status:", loginPageRes.status);
      return NextResponse.json({ error: "Cannot connect to Label Studio" }, { status: 502 });
    }

    // Step 2: POST login form
    const loginRes = await fetch(`${lsUrl}/user/login/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `csrftoken=${csrfToken}`,
        Referer: `${lsUrl}/user/login/`,
        Origin: lsUrl,
        "User-Agent": "BlueprintParser/1.0",
      },
      body: new URLSearchParams({
        email: lsEmail,
        password: lsPassword,
        csrfmiddlewaretoken: csrfToken,
      }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });

    if (loginRes.status !== 302) {
      const body = await loginRes.text().catch(() => "");
      console.error("[LS-LOGIN] Login failed, status:", loginRes.status, "body:", body.slice(0, 300));
      return NextResponse.json(
        { error: "Label Studio login failed", hint: loginRes.status === 200 ? "Check credentials" : `Unexpected status ${loginRes.status}` },
        { status: 502 }
      );
    }

    // Step 3: Extract sessionid cookie
    let sessionId = "";

    const loginRawCookie = loginRes.headers.get("set-cookie") || "";
    const sessionMatch = loginRawCookie.match(/sessionid=([^;,\s]+)/);
    if (sessionMatch) {
      sessionId = sessionMatch[1];
    }

    if (!sessionId && typeof loginRes.headers.getSetCookie === "function") {
      for (const c of loginRes.headers.getSetCookie()) {
        const m = c.match(/sessionid=([^;]+)/);
        if (m) { sessionId = m[1]; break; }
      }
    }

    if (!sessionId) {
      console.error("[LS-LOGIN] No sessionid in login response");
      return NextResponse.json({ error: "Login succeeded but session not returned" }, { status: 502 });
    }

    // Step 4: Return HTML relay page that sets cookie then redirects
    const targetUrl = `${lsUrl}${redirect.startsWith("/") ? redirect : "/" + redirect}`;

    // Compute shared cookie domain
    const lsHost = new URL(lsUrl).hostname;
    const appHost = process.env.NEXTAUTH_URL ? new URL(process.env.NEXTAUTH_URL).hostname : "";
    const lsParts = lsHost.split(".");
    const appParts = appHost.split(".");
    let cookieDomain = "";

    if (lsParts.length >= 2 && appParts.length >= 2) {
      const lsParent = lsParts.slice(-2).join(".");
      const appParent = appParts.slice(-2).join(".");
      if (lsParent === appParent && lsParent !== "localhost") {
        cookieDomain = `.${lsParent}`;
      }
    }

    // Return 200 HTML page with Set-Cookie + client-side redirect.
    // Using 200 (not 307) guarantees the browser processes Set-Cookie
    // before navigating to the cross-origin LS domain.
    const safeTargetUrl = targetUrl.replace(/"/g, "&quot;");
    const html = `<!DOCTYPE html><html><head>
<meta http-equiv="refresh" content="0;url=${safeTargetUrl}">
</head><body>
<script>window.location.href="${safeTargetUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";</script>
<p>Redirecting to Label Studio...</p>
</body></html>`;

    const response = new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });

    response.cookies.set("sessionid", sessionId, {
      domain: cookieDomain || undefined,
      path: "/",
      secure: lsUrl.startsWith("https"),
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 14,
    });

    return response;

  } catch (err: any) {
    console.error("[LS-LOGIN] Error:", err.message);
    return NextResponse.json({ error: "Auto-login failed" }, { status: 500 });
  }
}
